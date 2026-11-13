//! NEARFirewall account policy.
//!
//! This contract is deployed on the payer's own NEAR account. Agents ask it to
//! pay in one of two ways:
//!
//! - **Executor mode:** the agent's executor account calls the registry's
//!   `execute`, and the trusted registry forwards the request here (`on_execute`).
//! - **Connection mode:** the agent signs `agent_execute` with a function-call key
//!   on this account that can call nothing else. The policy maps the signing key
//!   to a connection (an agent plus the platform it runs on), asks the registry to
//!   `authorize` the agent, then runs the same checks.
//!
//! Either way it checks the owner's mandates and recipient rules, reserves the
//! amount, and sends native NEAR from the account itself. Payments above an
//! "ask me first" threshold wait for the owner to confirm. Only the account
//! itself (its full-access keys, with 1 yoctoNEAR attached) can change the policy.

// Contract methods take named JSON arguments, so long parameter lists are expected.
#![allow(clippy::too_many_arguments)]

use std::collections::BTreeMap;

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseError, PromiseOrValue, PublicKey,
};
use nearfirewall_types::{
    day_index, is_valid_request_id, Action, AgentId, Authorization, ExecContext, Outcome, PathNode,
    Reason, DAY_NS, MAX_DEPTH,
};

/// Maximum recipients one mandate can approve.
pub const MAX_RECIPIENTS: usize = 50;
/// Size of the activity ring buffer.
pub const ACTIVITY_SIZE: u64 = 64;
/// How long finished request IDs are kept for duplicate detection.
pub const REQUEST_RETENTION_NS: u64 = 2 * DAY_NS;
/// How many expired request records each execution prunes.
pub const PRUNE_PER_CALL: u32 = 5;
/// Default balance kept untouchable for storage growth and fees: 0.5 NEAR.
pub const DEFAULT_SAFETY_BUFFER: u128 = 500_000_000_000_000_000_000_000;
/// Connection limits.
pub const MAX_CONNECTIONS: usize = 50;
pub const MAX_CONNECTIONS_PER_AGENT: usize = 10;
pub const MAX_PLATFORM_BYTES: usize = 32;
pub const MAX_LABEL_BYTES: usize = 48;
pub const MAX_CLIENT_BYTES: usize = 64;
/// "Ask me first" limits.
pub const MAX_PENDING: usize = 20;
pub const MAX_PENDING_PER_AGENT: usize = 5;
/// How long a payment waits for confirmation before it can be expired.
pub const CONFIRM_WINDOW_NS: u64 = DAY_NS;
/// How many overdue confirmations each execution expires.
pub const EXPIRE_PER_CALL: usize = 3;
/// Blocklist limits. Guardians may add at most `MAX_GUARDIAN_BLOCKS` of the entries,
/// so a compromised guardian can never fill the list and lock the owner out of it.
pub const MAX_BLOCKED: usize = 100;
pub const MAX_GUARDIAN_BLOCKS: usize = 50;
pub const MAX_GUARDIANS: usize = 5;
pub const MAX_REASON_BYTES: usize = 120;
/// The only method a guardian key may call on this account.
pub const GUARDIAN_METHOD: &str = "guardian_block";

const GAS_FOR_SETTLE: Gas = Gas::from_tgas(10);
const GAS_FOR_AUTHORIZE: Gas = Gas::from_tgas(15);
const GAS_FOR_ON_AUTHORIZED: Gas = Gas::from_tgas(45);
/// Minimum prepaid gas for `agent_execute`, so the whole chain can finish.
pub const MIN_AGENT_EXECUTE_GAS: Gas = Gas::from_tgas(90);

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Mandates,
    Usage,
    Requests,
    Queue,
    Activity,
    Connections,
    Pending,
    Blocked,
    Guardians,
}

#[ext_contract(ext_registry)]
pub trait AgentRegistry {
    fn authorize(&mut self, agent_id: AgentId, action: Action, request_id: String)
        -> Authorization;
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecipientRule {
    pub per_payment_cap: U128,
    pub daily_cap: U128,
    pub expires_at: Option<u64>,
    /// Payments to this recipient above this amount wait for the owner ("ask me first").
    pub confirm_above: Option<U128>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct RecipientInput {
    pub recipient: AccountId,
    pub per_payment_cap: U128,
    pub daily_cap: U128,
    pub expires_at: Option<u64>,
    #[serde(default)]
    pub confirm_above: Option<U128>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MandateStatus {
    Active,
    Revoked,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Mandate {
    /// Generations of the agent and its ancestors when the mandate was set. Root first.
    pub path: Vec<PathNode>,
    pub status: MandateStatus,
    pub fixed: bool,
    pub expires_at: Option<u64>,
    /// Shared daily pool for the agent's whole branch.
    pub daily_cap: U128,
    pub recipients: BTreeMap<AccountId, RecipientRule>,
    /// Payments by this branch above this amount wait for the owner ("ask me first").
    pub confirm_above: Option<U128>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum UsageKey {
    Recipient(AgentId, AccountId),
    Mandate(AgentId),
    Account,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, Default)]
pub struct Usage {
    pub day: u64,
    /// Settled plus reserved amount for `day`.
    pub used: u128,
}

impl Usage {
    fn today(&self, today: u64) -> u128 {
        if self.day == today {
            self.used
        } else {
            0
        }
    }
}

/// How a request reached the policy.
#[near(serializers = [borsh, json])]
#[serde(tag = "kind", rename_all = "snake_case")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Via {
    /// Through the registry's `execute`, from the agent's executor account.
    Executor { account: AccountId },
    /// Through `agent_execute`, signed by a connection key on this account.
    Connection { public_key: String, label: String },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestStatus {
    /// The transfer is in flight.
    Pending,
    Settled,
    Failed,
    /// The owner declined it, or a recheck at confirmation refused it.
    Declined,
    /// Nobody confirmed it in time.
    Expired,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Request {
    pub leaf: AgentId,
    pub request_id: String,
    pub recipient: AccountId,
    pub amount: U128,
    pub day: u64,
    pub created_at: u64,
    pub status: RequestStatus,
    /// Agents whose mandates this request was counted against.
    pub mandates: Vec<AgentId>,
    pub via: Option<Via>,
    pub client: Option<String>,
}

/// A payment waiting for the owner ("ask me first"). Its amount is reserved.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct PendingConfirmation {
    pub leaf: AgentId,
    pub request_id: String,
    pub recipient: AccountId,
    pub amount: U128,
    pub day: u64,
    pub created_at: u64,
    pub expires_at: u64,
    pub path: Vec<PathNode>,
    pub mandates: Vec<AgentId>,
    pub via: Option<Via>,
    pub client: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Activity {
    pub seq: u64,
    pub at: u64,
    pub leaf: AgentId,
    pub request_id: String,
    pub recipient: AccountId,
    pub amount: U128,
    /// `settled`, `failed`, `denied`, `awaiting`, `declined`, or `expired`.
    pub outcome: String,
    pub reason: Option<Reason>,
    pub via: Option<Via>,
    /// The name the agent's MCP client reported. A hint only.
    pub client: Option<String>,
}

/// An agent key on this account, and the agent and platform it belongs to.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Connection {
    pub agent_id: AgentId,
    pub platform: String,
    pub label: String,
    pub created_at: u64,
    pub last_used: Option<u64>,
    pub uses: u64,
}

#[near(serializers = [json])]
pub struct ConnectionView {
    pub public_key: String,
    pub agent_id: AgentId,
    pub platform: String,
    pub label: String,
    pub created_at: u64,
    pub last_used: Option<u64>,
    pub uses: u64,
}

#[near(serializers = [json])]
pub struct PolicyView {
    pub account: AccountId,
    pub registry: AccountId,
    pub paused: bool,
    pub revision: u64,
    pub account_daily_cap: Option<U128>,
    pub account_used_today: U128,
    pub safety_buffer: U128,
    pub reserved_total: U128,
    pub available_balance: U128,
    pub day: u64,
    pub connections: u32,
    pub pending: u32,
    pub blocked: u32,
    pub guardians: u32,
}

#[near(serializers = [json])]
pub struct UsageView {
    pub day: u64,
    pub mandate_used_today: U128,
    pub recipient_used_today: Option<U128>,
    pub account_used_today: U128,
}

#[near(serializers = [json])]
pub struct Preview {
    pub allowed: bool,
    pub reason: Option<Reason>,
    /// Agents whose mandates would be charged.
    pub mandates: Vec<AgentId>,
    /// The payment would wait for the owner's confirmation.
    pub needs_confirmation: bool,
}

#[near(event_json(standard = "nearfirewall"))]
pub enum PolicyEvent {
    #[event_version("1.0.0")]
    PolicyInitialized { registry: AccountId },
    #[event_version("1.0.0")]
    MandateSet {
        agent_id: AgentId,
        fixed: bool,
        revision: u64,
    },
    #[event_version("1.0.0")]
    MandateRevoked { agent_id: AgentId, revision: u64 },
    #[event_version("1.0.0")]
    RecipientApproved {
        agent_id: AgentId,
        recipient: AccountId,
        revision: u64,
    },
    #[event_version("1.0.0")]
    RecipientRemoved {
        agent_id: AgentId,
        recipient: AccountId,
        revision: u64,
    },
    #[event_version("1.0.0")]
    PaymentsPaused { revision: u64 },
    #[event_version("1.0.0")]
    PaymentsResumed { revision: u64 },
    #[event_version("1.0.0")]
    AccountCapSet { cap: Option<U128>, revision: u64 },
    #[event_version("1.0.0")]
    ConfirmThresholdSet {
        agent_id: AgentId,
        recipient: Option<AccountId>,
        amount: Option<U128>,
        revision: u64,
    },
    #[event_version("1.0.0")]
    ConnectionAdded {
        agent_id: AgentId,
        public_key: String,
        platform: String,
        label: String,
    },
    #[event_version("1.0.0")]
    RecipientBlocked {
        recipient: AccountId,
        by: String,
        revision: u64,
    },
    #[event_version("1.0.0")]
    RecipientUnblocked { recipient: AccountId, revision: u64 },
    #[event_version("1.0.0")]
    GuardianAdded { public_key: String, label: String },
    #[event_version("1.0.0")]
    GuardianRemoved { public_key: String },
    #[event_version("1.0.0")]
    ConnectionRemoved {
        agent_id: AgentId,
        public_key: String,
    },
    #[event_version("1.0.0")]
    PaymentReserved {
        leaf: AgentId,
        request_id: String,
        recipient: AccountId,
        amount: U128,
    },
    #[event_version("1.0.0")]
    PaymentAwaitingConfirmation {
        leaf: AgentId,
        request_id: String,
        recipient: AccountId,
        amount: U128,
        expires_at: u64,
    },
    #[event_version("1.0.0")]
    PaymentConfirmed { leaf: AgentId, request_id: String },
    #[event_version("1.0.0")]
    PaymentDeclined {
        leaf: AgentId,
        request_id: String,
        reason: Reason,
    },
    #[event_version("1.0.0")]
    PaymentSettled { leaf: AgentId, request_id: String },
    #[event_version("1.0.0")]
    PaymentFailed { leaf: AgentId, request_id: String },
    #[event_version("1.0.0")]
    PaymentDenied {
        leaf: AgentId,
        request_id: String,
        reason: Reason,
    },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct AccountPolicy {
    registry: AccountId,
    paused: bool,
    revision: u64,
    account_daily_cap: Option<U128>,
    safety_buffer: u128,
    reserved_total: u128,
    mandates: LookupMap<AgentId, Mandate>,
    usage: LookupMap<UsageKey, Usage>,
    requests: LookupMap<String, Request>,
    queue: LookupMap<u64, String>,
    queue_head: u64,
    queue_tail: u64,
    activity: LookupMap<u64, Activity>,
    activity_next: u64,
    connections: LookupMap<String, Connection>,
    /// Public keys of every connection (at most `MAX_CONNECTIONS`).
    connection_index: Vec<String>,
    pending: LookupMap<String, PendingConfirmation>,
    /// Keys of every pending confirmation (at most `MAX_PENDING`).
    pending_keys: Vec<String>,
    /// Accounts no agent may pay, whatever the approvals say.
    blocked: LookupMap<AccountId, BlockedRecipient>,
    blocked_index: Vec<AccountId>,
    /// Keys that can only call `guardian_block`.
    guardians: LookupMap<String, Guardian>,
    guardian_index: Vec<String>,
}

/// An account on the blocklist.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct BlockedRecipient {
    pub recipient: AccountId,
    pub at: u64,
    /// `owner`, or `guardian:<label>`.
    pub by: String,
    pub reason: Option<String>,
}

/// A watcher key that can add recipients to the blocklist, and do nothing else.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Guardian {
    pub label: String,
    pub created_at: u64,
    pub last_used: Option<u64>,
    pub blocks: u64,
}

#[near(serializers = [json])]
pub struct GuardianView {
    pub public_key: String,
    pub label: String,
    pub created_at: u64,
    pub last_used: Option<u64>,
    pub blocks: u64,
}

pub(crate) fn request_key(leaf: &str, request_id: &str) -> String {
    format!("{leaf}:{request_id}")
}

fn expired(expires_at: Option<u64>, now: u64) -> bool {
    matches!(expires_at, Some(t) if t <= now)
}

fn validate_rule(owner: &AccountId, input: &RecipientInput) {
    require!(
        &input.recipient != owner,
        "The payer cannot approve itself as a recipient"
    );
    require!(
        input.per_payment_cap.0 > 0,
        "Per-payment cap must be greater than zero"
    );
    require!(input.daily_cap.0 > 0, "Daily cap must be greater than zero");
    require!(
        input.per_payment_cap.0 <= input.daily_cap.0,
        "Per-payment cap cannot exceed the daily cap"
    );
}

fn validate_text(value: &str, max: usize, what: &str) {
    require!(
        !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control),
        format!("{what} must be 1-{max} bytes of printable text")
    );
}

/// Keeps a client-reported name short and printable. It is a hint only.
fn clean_client(client: Option<String>) -> Option<String> {
    client
        .map(|c| {
            c.chars()
                .filter(|ch| ch.is_ascii_graphic() || *ch == ' ')
                .take(MAX_CLIENT_BYTES)
                .collect::<String>()
        })
        .filter(|c| !c.is_empty())
}

fn min_opt(a: Option<u128>, b: Option<u128>) -> Option<u128> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.min(y)),
        (x, None) => x,
        (None, y) => y,
    }
}

#[near]
impl AccountPolicy {
    /// Initializes the policy. Must be called by the account itself, in the same
    /// batch as the deployment.
    #[init]
    pub fn initialize(registry: AccountId, account_daily_cap: Option<U128>) -> Self {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "Only the account itself can initialize its policy"
        );
        require!(
            registry != env::current_account_id(),
            "The registry cannot be the payer account"
        );
        PolicyEvent::PolicyInitialized {
            registry: registry.clone(),
        }
        .emit();
        Self {
            registry,
            paused: false,
            revision: 0,
            account_daily_cap,
            safety_buffer: DEFAULT_SAFETY_BUFFER,
            reserved_total: 0,
            mandates: LookupMap::new(StorageKey::Mandates),
            usage: LookupMap::new(StorageKey::Usage),
            requests: LookupMap::new(StorageKey::Requests),
            queue: LookupMap::new(StorageKey::Queue),
            queue_head: 0,
            queue_tail: 0,
            activity: LookupMap::new(StorageKey::Activity),
            activity_next: 0,
            connections: LookupMap::new(StorageKey::Connections),
            connection_index: Vec::new(),
            pending: LookupMap::new(StorageKey::Pending),
            pending_keys: Vec::new(),
            blocked: LookupMap::new(StorageKey::Blocked),
            blocked_index: Vec::new(),
            guardians: LookupMap::new(StorageKey::Guardians),
            guardian_index: Vec::new(),
        }
    }

    // ---------------------------------------------------------------- owner writes

    /// Creates or replaces the mandate for `agent_id`, with its initial recipients.
    /// `path` is the agent's path from the registry (`get_path`), root first.
    /// `confirm_above` makes larger payments by this branch wait for the owner.
    #[payable]
    pub fn set_mandate(
        &mut self,
        agent_id: AgentId,
        path: Vec<PathNode>,
        daily_cap: U128,
        expires_at: Option<u64>,
        fixed: bool,
        recipients: Vec<RecipientInput>,
        confirm_above: Option<U128>,
    ) {
        self.assert_owner();
        require!(
            !path.is_empty() && path.len() <= MAX_DEPTH,
            "Path length is out of range"
        );
        require!(
            path.last().unwrap().agent_id == agent_id,
            "Path must end at the agent"
        );
        require!(daily_cap.0 > 0, "Daily cap must be greater than zero");
        require!(recipients.len() <= MAX_RECIPIENTS, "Too many recipients");
        if let Some(existing) = self.mandates.get(&agent_id) {
            require!(
                !(existing.fixed && existing.status == MandateStatus::Active),
                "A fixed mandate cannot be edited. Revoke it first."
            );
        }
        let owner = env::current_account_id();
        let mut rules = BTreeMap::new();
        for input in &recipients {
            validate_rule(&owner, input);
            let rule = RecipientRule {
                per_payment_cap: input.per_payment_cap,
                daily_cap: input.daily_cap,
                expires_at: input.expires_at,
                confirm_above: input.confirm_above,
            };
            require!(
                rules.insert(input.recipient.clone(), rule).is_none(),
                "Duplicate recipient"
            );
        }
        self.mandates.insert(
            agent_id.clone(),
            Mandate {
                path,
                status: MandateStatus::Active,
                fixed,
                expires_at,
                daily_cap,
                recipients: rules,
                confirm_above,
            },
        );
        let revision = self.bump_revision();
        PolicyEvent::MandateSet {
            agent_id,
            fixed,
            revision,
        }
        .emit();
    }

    /// Adds or replaces one recipient rule on an active, editable mandate. A
    /// replaced rule keeps its "ask me first" threshold.
    #[payable]
    pub fn approve_recipient(
        &mut self,
        agent_id: AgentId,
        recipient: AccountId,
        per_payment_cap: U128,
        daily_cap: U128,
        expires_at: Option<u64>,
    ) {
        self.assert_owner();
        let input = RecipientInput {
            recipient: recipient.clone(),
            per_payment_cap,
            daily_cap,
            expires_at,
            confirm_above: None,
        };
        validate_rule(&env::current_account_id(), &input);
        let mandate = self.editable_mandate(&agent_id);
        let confirm_above = mandate
            .recipients
            .get(&recipient)
            .and_then(|r| r.confirm_above);
        if !mandate.recipients.contains_key(&recipient) {
            require!(
                mandate.recipients.len() < MAX_RECIPIENTS,
                "Too many recipients"
            );
        }
        mandate.recipients.insert(
            recipient.clone(),
            RecipientRule {
                per_payment_cap,
                daily_cap,
                expires_at,
                confirm_above,
            },
        );
        let revision = self.bump_revision();
        PolicyEvent::RecipientApproved {
            agent_id,
            recipient,
            revision,
        }
        .emit();
    }

    /// Sets the "ask me first" threshold for a mandate, or for one of its
    /// recipients when `recipient` is given. `None` removes it.
    #[payable]
    pub fn set_confirm_above(
        &mut self,
        agent_id: AgentId,
        recipient: Option<AccountId>,
        amount: Option<U128>,
    ) {
        self.assert_owner();
        let mandate = self.editable_mandate(&agent_id);
        match &recipient {
            Some(r) => {
                let rule = mandate
                    .recipients
                    .get_mut(r)
                    .unwrap_or_else(|| env::panic_str("Recipient is not approved"));
                rule.confirm_above = amount;
            }
            None => mandate.confirm_above = amount,
        }
        let revision = self.bump_revision();
        PolicyEvent::ConfirmThresholdSet {
            agent_id,
            recipient,
            amount,
            revision,
        }
        .emit();
    }

    /// Removes one recipient rule. Today's usage for the recipient is preserved.
    #[payable]
    pub fn remove_recipient(&mut self, agent_id: AgentId, recipient: AccountId) {
        self.assert_owner();
        let mandate = self.editable_mandate(&agent_id);
        require!(
            mandate.recipients.remove(&recipient).is_some(),
            "Recipient is not approved"
        );
        let key = UsageKey::Recipient(agent_id.clone(), recipient.clone());
        let today = day_index(env::block_timestamp());
        if matches!(self.usage.get(&key), Some(u) if u.day < today) {
            self.usage.remove(&key);
        }
        let revision = self.bump_revision();
        PolicyEvent::RecipientRemoved {
            agent_id,
            recipient,
            revision,
        }
        .emit();
    }

    /// Revokes a mandate, fixed or not. A new one can be set afterwards.
    #[payable]
    pub fn revoke_mandate(&mut self, agent_id: AgentId) {
        self.assert_owner();
        let mandate = self
            .mandates
            .get_mut(&agent_id)
            .unwrap_or_else(|| env::panic_str("No mandate for agent"));
        mandate.status = MandateStatus::Revoked;
        let revision = self.bump_revision();
        PolicyEvent::MandateRevoked { agent_id, revision }.emit();
    }

    #[payable]
    pub fn pause(&mut self) {
        self.assert_owner();
        self.paused = true;
        let revision = self.bump_revision();
        PolicyEvent::PaymentsPaused { revision }.emit();
    }

    #[payable]
    pub fn resume(&mut self) {
        self.assert_owner();
        self.paused = false;
        let revision = self.bump_revision();
        PolicyEvent::PaymentsResumed { revision }.emit();
    }

    #[payable]
    pub fn set_account_daily_cap(&mut self, cap: Option<U128>) {
        self.assert_owner();
        self.account_daily_cap = cap;
        let revision = self.bump_revision();
        PolicyEvent::AccountCapSet { cap, revision }.emit();
    }

    #[payable]
    pub fn set_safety_buffer(&mut self, amount: U128) {
        self.assert_owner();
        self.safety_buffer = amount.0;
        self.bump_revision();
    }

    // ---------------------------------------------------------------- connections

    /// Records a connection: the agent key `public_key` acts for `agent_id`. The
    /// app adds the key itself (a function-call key on this account, limited to
    /// `agent_execute`) in the same transaction.
    #[payable]
    pub fn connect_agent_key(
        &mut self,
        agent_id: AgentId,
        public_key: PublicKey,
        platform: String,
        label: String,
    ) {
        self.assert_owner();
        validate_text(&agent_id, 20, "The agent ID");
        validate_text(&platform, MAX_PLATFORM_BYTES, "The platform");
        validate_text(&label, MAX_LABEL_BYTES, "The label");
        let key = String::from(&public_key);
        require!(
            !self.connections.contains_key(&key),
            "This key is already connected"
        );
        require!(
            !self.guardians.contains_key(&key),
            "This key is a guardian key"
        );
        require!(
            self.connection_index.len() < MAX_CONNECTIONS,
            "Too many connections on this account"
        );
        let for_agent = self
            .connection_index
            .iter()
            .filter(|k| {
                self.connections
                    .get(*k)
                    .map(|c| c.agent_id == agent_id)
                    .unwrap_or(false)
            })
            .count();
        require!(
            for_agent < MAX_CONNECTIONS_PER_AGENT,
            "Too many connections for this agent"
        );
        self.connections.insert(
            key.clone(),
            Connection {
                agent_id: agent_id.clone(),
                platform: platform.clone(),
                label: label.clone(),
                created_at: env::block_timestamp(),
                last_used: None,
                uses: 0,
            },
        );
        self.connection_index.push(key.clone());
        PolicyEvent::ConnectionAdded {
            agent_id,
            public_key: key,
            platform,
            label,
        }
        .emit();
    }

    /// Removes a connection. The app deletes the key in the same transaction.
    #[payable]
    pub fn disconnect_agent_key(&mut self, public_key: PublicKey) {
        self.assert_owner();
        let key = String::from(&public_key);
        let connection = self
            .connections
            .remove(&key)
            .unwrap_or_else(|| env::panic_str("This key is not connected"));
        self.connection_index.retain(|k| k != &key);
        PolicyEvent::ConnectionRemoved {
            agent_id: connection.agent_id,
            public_key: key,
        }
        .emit();
    }

    // ---------------------------------------------------------------- blocklist

    /// Blocks `recipient` for every agent, whatever the approvals say. Takes
    /// effect for the next request.
    #[payable]
    pub fn block_recipient(&mut self, recipient: AccountId, reason: Option<String>) {
        self.assert_owner();
        require!(
            recipient != env::current_account_id(),
            "The account cannot block itself"
        );
        if let Some(reason) = &reason {
            validate_text(reason, MAX_REASON_BYTES, "The reason");
        }
        if !self.blocked.contains_key(&recipient) {
            require!(
                self.blocked_index.len() < MAX_BLOCKED,
                "The blocklist is full"
            );
            self.blocked_index.push(recipient.clone());
        }
        self.blocked.insert(
            recipient.clone(),
            BlockedRecipient {
                recipient: recipient.clone(),
                at: env::block_timestamp(),
                by: "owner".to_string(),
                reason,
            },
        );
        let revision = self.bump_revision();
        PolicyEvent::RecipientBlocked {
            recipient,
            by: "owner".to_string(),
            revision,
        }
        .emit();
    }

    /// Removes a recipient from the blocklist. Only the owner can do this.
    #[payable]
    pub fn unblock_recipient(&mut self, recipient: AccountId) {
        self.assert_owner();
        require!(
            self.blocked.remove(&recipient).is_some(),
            "This recipient is not blocked"
        );
        self.blocked_index.retain(|r| r != &recipient);
        let revision = self.bump_revision();
        PolicyEvent::RecipientUnblocked {
            recipient,
            revision,
        }
        .emit();
    }

    /// Records a guardian: a watcher key that can only add recipients to the
    /// blocklist. The app adds the key itself (a function-call key on this
    /// account, limited to `guardian_block`) in the same transaction.
    #[payable]
    pub fn add_guardian_key(&mut self, public_key: PublicKey, label: String) {
        self.assert_owner();
        validate_text(&label, MAX_LABEL_BYTES, "The label");
        let key = String::from(&public_key);
        require!(
            !self.guardians.contains_key(&key),
            "This key is already a guardian"
        );
        require!(
            !self.connections.contains_key(&key),
            "This key is a connected agent key"
        );
        require!(
            self.guardian_index.len() < MAX_GUARDIANS,
            "Too many guardians"
        );
        self.guardians.insert(
            key.clone(),
            Guardian {
                label: label.clone(),
                created_at: env::block_timestamp(),
                last_used: None,
                blocks: 0,
            },
        );
        self.guardian_index.push(key.clone());
        PolicyEvent::GuardianAdded {
            public_key: key,
            label,
        }
        .emit();
    }

    /// Removes a guardian. The app deletes the key in the same transaction.
    /// Entries the guardian added stay until the owner removes them.
    #[payable]
    pub fn remove_guardian_key(&mut self, public_key: PublicKey) {
        self.assert_owner();
        let key = String::from(&public_key);
        require!(
            self.guardians.remove(&key).is_some(),
            "This key is not a guardian"
        );
        self.guardian_index.retain(|k| k != &key);
        PolicyEvent::GuardianRemoved { public_key: key }.emit();
    }

    /// Guardian only: adds `recipient` to the blocklist. A guardian can never
    /// unblock, approve, or raise a limit, cannot overwrite the owner's entries,
    /// and may add at most `MAX_GUARDIAN_BLOCKS` entries. Returns whether the
    /// recipient was newly blocked.
    pub fn guardian_block(&mut self, recipient: AccountId, reason: Option<String>) -> bool {
        let me = env::current_account_id();
        require!(
            env::predecessor_account_id() == me && env::signer_account_id() == me,
            "Only a guardian key on this account can call this"
        );
        require!(
            env::attached_deposit().is_zero(),
            "A guardian cannot attach a deposit"
        );
        let key = String::from(&env::signer_account_pk());
        let label = self
            .guardians
            .get(&key)
            .map(|g| g.label.clone())
            .unwrap_or_else(|| env::panic_str("This key is not a guardian"));
        require!(recipient != me, "The account cannot block itself");
        let reason = reason.map(|r| {
            r.chars()
                .filter(|c| !c.is_control())
                .take(MAX_REASON_BYTES)
                .collect::<String>()
        });
        if self.blocked.contains_key(&recipient) {
            return false;
        }
        let by_guardians = self
            .blocked_index
            .iter()
            .filter(|r| {
                self.blocked
                    .get(*r)
                    .map(|b| b.by.starts_with("guardian:"))
                    .unwrap_or(false)
            })
            .count();
        require!(
            by_guardians < MAX_GUARDIAN_BLOCKS,
            "Guardians have reached their limit. The owner must review the blocklist."
        );
        require!(
            self.blocked_index.len() < MAX_BLOCKED,
            "The blocklist is full"
        );
        let by = format!("guardian:{label}");
        self.blocked_index.push(recipient.clone());
        self.blocked.insert(
            recipient.clone(),
            BlockedRecipient {
                recipient: recipient.clone(),
                at: env::block_timestamp(),
                by: by.clone(),
                reason,
            },
        );
        if let Some(guardian) = self.guardians.get_mut(&key) {
            guardian.blocks += 1;
            guardian.last_used = Some(env::block_timestamp());
        }
        let revision = self.bump_revision();
        PolicyEvent::RecipientBlocked {
            recipient,
            by,
            revision,
        }
        .emit();
        true
    }

    // ---------------------------------------------------------------- execution

    /// Executor mode: called by the trusted registry with an authenticated request.
    pub fn on_execute(&mut self, ctx: ExecContext) -> PromiseOrValue<Outcome> {
        if env::predecessor_account_id() != self.registry {
            return PromiseOrValue::Value(Outcome::denied(Reason::UntrustedCaller));
        }
        if ctx.path.is_empty()
            || ctx.path.len() > MAX_DEPTH
            || !is_valid_request_id(&ctx.request_id)
        {
            return PromiseOrValue::Value(Outcome::denied(Reason::InvalidRequest));
        }
        let via = Some(Via::Executor {
            account: ctx.executor.clone(),
        });
        self.admit(
            ctx.path,
            ctx.action,
            ctx.request_id,
            ctx.expected_revision,
            via,
            None,
        )
    }

    /// Connection mode: signed by an agent key on this account. The key can call
    /// only this method, cannot attach a deposit, and is mapped to one agent.
    pub fn agent_execute(
        &mut self,
        action: Action,
        request_id: String,
        client: Option<String>,
    ) -> PromiseOrValue<Outcome> {
        let me = env::current_account_id();
        // Only a transaction signed on this account, calling it directly, can be a connection.
        if env::predecessor_account_id() != me || env::signer_account_id() != me {
            return PromiseOrValue::Value(Outcome::denied(Reason::UnknownConnection));
        }
        let public_key = String::from(&env::signer_account_pk());
        let Some(connection) = self.connections.get(&public_key).cloned() else {
            return PromiseOrValue::Value(Outcome::denied(Reason::UnknownConnection));
        };
        if !is_valid_request_id(&request_id) {
            return PromiseOrValue::Value(Outcome::denied(Reason::InvalidRequest));
        }
        let key = request_key(&connection.agent_id, &request_id);
        if self.requests.contains_key(&key) || self.pending.contains_key(&key) {
            return PromiseOrValue::Value(Outcome::denied(Reason::DuplicateRequest));
        }
        require!(
            env::prepaid_gas() >= MIN_AGENT_EXECUTE_GAS,
            "Attach at least 90 Tgas to agent_execute"
        );
        ext_registry::ext(self.registry.clone())
            .with_static_gas(GAS_FOR_AUTHORIZE)
            .with_unused_gas_weight(0)
            .authorize(connection.agent_id, action.clone(), request_id.clone())
            .then(
                Self::ext(me)
                    .with_static_gas(GAS_FOR_ON_AUTHORIZED)
                    .on_authorized(public_key, action, request_id, clean_client(client)),
            )
            .into()
    }

    /// The registry's answer for a connection request.
    #[private]
    pub fn on_authorized(
        &mut self,
        public_key: String,
        action: Action,
        request_id: String,
        client: Option<String>,
        #[callback_result] authorization: Result<Authorization, PromiseError>,
    ) -> PromiseOrValue<Outcome> {
        require!(
            env::promise_results_count() == 1,
            "Expected one promise result"
        );
        let recipient = action.recipient().clone();
        let amount = action.amount();
        let Some(connection) = self.connections.get(&public_key).cloned() else {
            // Disconnected while the registry was checking.
            let via = Some(Via::Connection {
                public_key,
                label: String::new(),
            });
            return PromiseOrValue::Value(self.deny(
                "?",
                &request_id,
                &recipient,
                amount,
                Reason::UnknownConnection,
                None,
                via,
                client,
            ));
        };
        let leaf = connection.agent_id.clone();
        let via = Some(Via::Connection {
            public_key: public_key.clone(),
            label: connection.label.clone(),
        });
        match authorization {
            Err(_) => PromiseOrValue::Value(self.deny(
                &leaf,
                &request_id,
                &recipient,
                amount,
                Reason::AuthorizationFailed,
                None,
                via,
                client,
            )),
            Ok(Authorization::Denied { reason, detail }) => PromiseOrValue::Value(self.deny(
                &leaf,
                &request_id,
                &recipient,
                amount,
                reason,
                detail,
                via,
                client,
            )),
            Ok(Authorization::Allowed { path }) => {
                if path.last().map(|n| &n.agent_id) != Some(&leaf) || path.len() > MAX_DEPTH {
                    return PromiseOrValue::Value(self.deny(
                        &leaf,
                        &request_id,
                        &recipient,
                        amount,
                        Reason::InvalidRequest,
                        None,
                        via,
                        client,
                    ));
                }
                if let Some(c) = self.connections.get_mut(&public_key) {
                    c.last_used = Some(env::block_timestamp());
                    c.uses += 1;
                }
                self.admit(path, action, request_id, None, via, client)
            }
        }
    }

    /// Records the transfer result. Idempotent.
    #[private]
    pub fn on_settle(&mut self, key: String) -> Outcome {
        require!(
            env::promise_results_count() == 1,
            "Expected one promise result"
        );
        // A transfer succeeds with an empty result; only `Failed` means the funds did not move.
        let success = !matches!(
            env::promise_result_checked(0, 64),
            Err(PromiseError::Failed)
        );
        self.settle(&key, success)
    }

    // ---------------------------------------------------------------- "ask me first"

    /// Confirms a payment that is waiting for the owner. The registry checks the
    /// agent again, then the policy rechecks the approval and the balance, and
    /// sends the payment.
    #[payable]
    pub fn confirm(
        &mut self,
        agent_id: AgentId,
        request_id: String,
        expected_revision: Option<u64>,
    ) -> PromiseOrValue<Outcome> {
        self.assert_owner();
        let key = request_key(&agent_id, &request_id);
        let pending = self
            .pending
            .get(&key)
            .cloned()
            .unwrap_or_else(|| env::panic_str("No payment is waiting with this request ID"));
        require!(
            env::block_timestamp() < pending.expires_at,
            "This payment has expired. Call expire to release it."
        );
        require!(!self.paused, "Payments are paused. Resume them first.");
        if let Some(expected) = expected_revision {
            require!(
                expected == self.revision,
                "The policy changed since you looked at it"
            );
        }
        let action = Action::TransferNear {
            recipient: pending.recipient.clone(),
            amount: pending.amount,
        };
        ext_registry::ext(self.registry.clone())
            .with_static_gas(GAS_FOR_AUTHORIZE)
            .with_unused_gas_weight(0)
            .authorize(pending.leaf, action, request_id)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_AUTHORIZED)
                    .on_confirm_authorized(key),
            )
            .into()
    }

    /// The registry's answer for a confirmation.
    #[private]
    pub fn on_confirm_authorized(
        &mut self,
        key: String,
        #[callback_result] authorization: Result<Authorization, PromiseError>,
    ) -> PromiseOrValue<Outcome> {
        require!(
            env::promise_results_count() == 1,
            "Expected one promise result"
        );
        let Some(pending) = self.pending.get(&key).cloned() else {
            return PromiseOrValue::Value(Outcome::denied(Reason::InvalidRequest));
        };
        let path = match authorization {
            Err(_) => {
                return PromiseOrValue::Value(self.finish_pending(
                    &key,
                    RequestStatus::Declined,
                    Reason::AuthorizationFailed,
                ))
            }
            Ok(Authorization::Denied { reason, .. }) => {
                return PromiseOrValue::Value(self.finish_pending(
                    &key,
                    RequestStatus::Declined,
                    reason,
                ))
            }
            Ok(Authorization::Allowed { path }) => path,
        };
        if let Err(reason) = self.recheck(&pending, &path) {
            return PromiseOrValue::Value(self.finish_pending(
                &key,
                RequestStatus::Declined,
                reason,
            ));
        }
        self.pending.remove(&key);
        self.pending_keys.retain(|k| k != &key);
        PolicyEvent::PaymentConfirmed {
            leaf: pending.leaf.clone(),
            request_id: pending.request_id.clone(),
        }
        .emit();
        let recipient = pending.recipient.clone();
        let amount = pending.amount.0;
        self.store_in_flight(
            key.clone(),
            pending.leaf,
            pending.request_id,
            recipient.clone(),
            amount,
            pending.day,
            pending.mandates,
            pending.via,
            pending.client,
        );
        Promise::new(recipient)
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_SETTLE)
                    .on_settle(key),
            )
            .into()
    }

    /// Declines a payment that is waiting for the owner. The reservation is released.
    #[payable]
    pub fn decline(&mut self, agent_id: AgentId, request_id: String) -> Outcome {
        self.assert_owner();
        let key = request_key(&agent_id, &request_id);
        require!(
            self.pending.contains_key(&key),
            "No payment is waiting with this request ID"
        );
        self.finish_pending(&key, RequestStatus::Declined, Reason::ConfirmationDeclined)
    }

    /// Releases a waiting payment nobody confirmed in time. Anyone can call it.
    pub fn expire(&mut self, agent_id: AgentId, request_id: String) -> Outcome {
        let key = request_key(&agent_id, &request_id);
        let pending = self
            .pending
            .get(&key)
            .unwrap_or_else(|| env::panic_str("No payment is waiting with this request ID"));
        require!(
            env::block_timestamp() >= pending.expires_at,
            "This payment has not expired yet"
        );
        self.finish_pending(&key, RequestStatus::Expired, Reason::ConfirmationExpired)
    }

    // ---------------------------------------------------------------- views

    pub fn get_policy(&self) -> PolicyView {
        let today = day_index(env::block_timestamp());
        PolicyView {
            account: env::current_account_id(),
            registry: self.registry.clone(),
            paused: self.paused,
            revision: self.revision,
            account_daily_cap: self.account_daily_cap,
            account_used_today: U128(self.used(&UsageKey::Account, today)),
            safety_buffer: U128(self.safety_buffer),
            reserved_total: U128(self.reserved_total),
            available_balance: U128(self.available_balance()),
            day: today,
            connections: self.connection_index.len() as u32,
            pending: self.pending_keys.len() as u32,
            blocked: self.blocked_index.len() as u32,
            guardians: self.guardian_index.len() as u32,
        }
    }

    /// Every blocked recipient, newest last.
    pub fn get_blocklist(&self) -> Vec<BlockedRecipient> {
        self.blocked_index
            .iter()
            .filter_map(|r| self.blocked.get(r).cloned())
            .collect()
    }

    pub fn is_blocked(&self, recipient: AccountId) -> bool {
        self.blocked.contains_key(&recipient)
    }

    pub fn get_guardians(&self) -> Vec<GuardianView> {
        self.guardian_index
            .iter()
            .filter_map(|k| self.guardians.get(k).map(|g| (k, g)))
            .map(|(k, g)| GuardianView {
                public_key: k.clone(),
                label: g.label.clone(),
                created_at: g.created_at,
                last_used: g.last_used,
                blocks: g.blocks,
            })
            .collect()
    }

    pub fn get_revision(&self) -> u64 {
        self.revision
    }

    pub fn get_mandate(&self, agent_id: AgentId) -> Option<Mandate> {
        self.mandates.get(&agent_id).cloned()
    }

    pub fn get_usage(&self, agent_id: AgentId, recipient: Option<AccountId>) -> UsageView {
        let today = day_index(env::block_timestamp());
        UsageView {
            day: today,
            mandate_used_today: U128(self.used(&UsageKey::Mandate(agent_id.clone()), today)),
            recipient_used_today: recipient
                .map(|r| U128(self.used(&UsageKey::Recipient(agent_id, r), today))),
            account_used_today: U128(self.used(&UsageKey::Account, today)),
        }
    }

    pub fn get_request(&self, leaf: AgentId, request_id: String) -> Option<Request> {
        self.requests.get(&request_key(&leaf, &request_id)).cloned()
    }

    /// Newest first. `before` is an exclusive sequence number for paging.
    pub fn get_activity(&self, before: Option<u64>, limit: Option<u64>) -> Vec<Activity> {
        let end = before.unwrap_or(self.activity_next).min(self.activity_next);
        let start = self.activity_next.saturating_sub(ACTIVITY_SIZE);
        let limit = limit.unwrap_or(20).min(ACTIVITY_SIZE);
        (start..end)
            .rev()
            .take(limit as usize)
            .filter_map(|seq| {
                self.activity
                    .get(&(seq % ACTIVITY_SIZE))
                    .filter(|a| a.seq == seq)
                    .cloned()
            })
            .collect()
    }

    /// Every connection, or only those of `agent_id`.
    pub fn get_connections(&self, agent_id: Option<AgentId>) -> Vec<ConnectionView> {
        self.connection_index
            .iter()
            .filter_map(|k| self.connections.get(k).map(|c| (k, c)))
            .filter(|(_, c)| agent_id.as_ref().map(|a| &c.agent_id == a).unwrap_or(true))
            .map(|(k, c)| ConnectionView {
                public_key: k.clone(),
                agent_id: c.agent_id.clone(),
                platform: c.platform.clone(),
                label: c.label.clone(),
                created_at: c.created_at,
                last_used: c.last_used,
                uses: c.uses,
            })
            .collect()
    }

    pub fn get_connection(&self, public_key: PublicKey) -> Option<ConnectionView> {
        let key = String::from(&public_key);
        self.connections.get(&key).map(|c| ConnectionView {
            public_key: key.clone(),
            agent_id: c.agent_id.clone(),
            platform: c.platform.clone(),
            label: c.label.clone(),
            created_at: c.created_at,
            last_used: c.last_used,
            uses: c.uses,
        })
    }

    /// Payments waiting for the owner, oldest first.
    pub fn get_pending(&self) -> Vec<PendingConfirmation> {
        self.pending_keys
            .iter()
            .filter_map(|k| self.pending.get(k).cloned())
            .collect()
    }

    /// Runs every payer-side check without changing state. The caller check is
    /// skipped, since views have no caller.
    pub fn preview(&self, ctx: ExecContext) -> Preview {
        let refuse = |reason| Preview {
            allowed: false,
            reason: Some(reason),
            mandates: vec![],
            needs_confirmation: false,
        };
        if ctx.path.is_empty()
            || ctx.path.len() > MAX_DEPTH
            || !is_valid_request_id(&ctx.request_id)
        {
            return refuse(Reason::InvalidRequest);
        }
        let key = request_key(&ctx.leaf().agent_id, &ctx.request_id);
        if self.requests.contains_key(&key) || self.pending.contains_key(&key) {
            return refuse(Reason::DuplicateRequest);
        }
        match self.check(&ctx.path, &ctx.action, ctx.expected_revision) {
            Ok(mandates) => {
                let needs_confirmation = self
                    .confirm_threshold(&mandates, ctx.action.recipient())
                    .map(|t| ctx.action.amount() > t)
                    .unwrap_or(false);
                Preview {
                    allowed: true,
                    reason: None,
                    mandates,
                    needs_confirmation,
                }
            }
            Err(reason) => refuse(reason),
        }
    }
}

// -------------------------------------------------------------------- internals

impl AccountPolicy {
    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "Only the account itself can change its policy"
        );
        assert_one_yocto();
    }

    fn bump_revision(&mut self) -> u64 {
        self.revision += 1;
        self.revision
    }

    fn editable_mandate(&mut self, agent_id: &AgentId) -> &mut Mandate {
        let mandate = self
            .mandates
            .get_mut(agent_id)
            .unwrap_or_else(|| env::panic_str("No mandate for agent"));
        require!(
            mandate.status == MandateStatus::Active,
            "Mandate is revoked"
        );
        require!(
            !mandate.fixed,
            "A fixed mandate cannot be edited. Revoke it first."
        );
        mandate
    }

    fn used(&self, key: &UsageKey, today: u64) -> u128 {
        self.usage.get(key).map(|u| u.today(today)).unwrap_or(0)
    }

    fn add_usage(&mut self, key: UsageKey, today: u64, amount: u128) {
        let current = self.used(&key, today);
        self.usage.insert(
            key,
            Usage {
                day: today,
                used: current + amount,
            },
        );
    }

    fn release_usage(&mut self, key: UsageKey, day: u64, amount: u128) {
        if let Some(usage) = self.usage.get_mut(&key) {
            if usage.day == day {
                usage.used = usage.used.saturating_sub(amount);
            }
        }
    }

    fn reserve(&mut self, mandates: &[AgentId], recipient: &AccountId, day: u64, amount: u128) {
        for agent_id in mandates {
            self.add_usage(UsageKey::Mandate(agent_id.clone()), day, amount);
            self.add_usage(
                UsageKey::Recipient(agent_id.clone(), recipient.clone()),
                day,
                amount,
            );
        }
        self.add_usage(UsageKey::Account, day, amount);
        self.reserved_total += amount;
    }

    fn release_reservation(
        &mut self,
        mandates: &[AgentId],
        recipient: &AccountId,
        day: u64,
        amount: u128,
    ) {
        for agent_id in mandates {
            self.release_usage(UsageKey::Mandate(agent_id.clone()), day, amount);
            self.release_usage(
                UsageKey::Recipient(agent_id.clone(), recipient.clone()),
                day,
                amount,
            );
        }
        self.release_usage(UsageKey::Account, day, amount);
        self.reserved_total = self.reserved_total.saturating_sub(amount);
    }

    /// Balance minus storage and the safety buffer, before reservations.
    fn spendable_balance(&self) -> u128 {
        let storage_cost =
            env::storage_byte_cost().as_yoctonear() * u128::from(env::storage_usage());
        env::account_balance()
            .as_yoctonear()
            .saturating_sub(storage_cost)
            .saturating_sub(self.safety_buffer)
    }

    fn available_balance(&self) -> u128 {
        self.spendable_balance().saturating_sub(self.reserved_total)
    }

    /// The lowest "ask me first" threshold among the mandates that apply.
    fn confirm_threshold(&self, mandates: &[AgentId], recipient: &AccountId) -> Option<u128> {
        let mut threshold = None;
        for agent_id in mandates {
            if let Some(m) = self.mandates.get(agent_id) {
                threshold = min_opt(threshold, m.confirm_above.map(|c| c.0));
                threshold = min_opt(
                    threshold,
                    m.recipients
                        .get(recipient)
                        .and_then(|r| r.confirm_above)
                        .map(|c| c.0),
                );
            }
        }
        threshold
    }

    /// Checks a request against the policy. Returns the agents whose mandates apply.
    fn check(
        &self,
        path: &[PathNode],
        action: &Action,
        expected_revision: Option<u64>,
    ) -> Result<Vec<AgentId>, Reason> {
        if self.paused {
            return Err(Reason::PaymentsPaused);
        }
        if let Some(expected) = expected_revision {
            if expected != self.revision {
                return Err(Reason::RevisionMismatch);
            }
        }
        let now = env::block_timestamp();
        let today = day_index(now);
        let recipient = action.recipient();
        let amount = action.amount();
        if amount == 0 {
            return Err(Reason::InvalidRequest);
        }
        // The blocklist wins over every approval.
        if self.blocked.contains_key(recipient) {
            return Err(Reason::RecipientBlocked);
        }

        let mut applied = Vec::new();
        for (i, node) in path.iter().enumerate() {
            let Some(mandate) = self.mandates.get(&node.agent_id) else {
                continue;
            };
            if mandate.status == MandateStatus::Revoked {
                return Err(Reason::MandateRevoked);
            }
            if mandate.path.as_slice() != &path[..=i] {
                return Err(Reason::MandateStale);
            }
            if expired(mandate.expires_at, now) {
                return Err(Reason::MandateExpired);
            }
            let rule = mandate
                .recipients
                .get(recipient)
                .ok_or(Reason::RecipientNotApproved)?;
            if expired(rule.expires_at, now) {
                return Err(Reason::RecipientRuleExpired);
            }
            if amount > rule.per_payment_cap.0 {
                return Err(Reason::PerPaymentCap);
            }
            let recipient_used = self.used(
                &UsageKey::Recipient(node.agent_id.clone(), recipient.clone()),
                today,
            );
            if recipient_used + amount > rule.daily_cap.0 {
                return Err(Reason::RecipientDailyCap);
            }
            if self.used(&UsageKey::Mandate(node.agent_id.clone()), today) + amount
                > mandate.daily_cap.0
            {
                return Err(Reason::MandateDailyCap);
            }
            applied.push(node.agent_id.clone());
        }
        if applied.is_empty() {
            return Err(Reason::NoMandate);
        }
        if let Some(cap) = self.account_daily_cap {
            if self.used(&UsageKey::Account, today) + amount > cap.0 {
                return Err(Reason::AccountDailyCap);
            }
        }
        if amount > self.available_balance() {
            return Err(Reason::InsufficientBalance);
        }
        Ok(applied)
    }

    /// Admits an authenticated request from either mode: duplicate check, policy
    /// check, then reserve and send, or reserve and wait for confirmation.
    fn admit(
        &mut self,
        path: Vec<PathNode>,
        action: Action,
        request_id: String,
        expected_revision: Option<u64>,
        via: Option<Via>,
        client: Option<String>,
    ) -> PromiseOrValue<Outcome> {
        let now = env::block_timestamp();
        self.prune(now);
        self.expire_overdue(now);

        let leaf = path.last().expect("path is never empty").agent_id.clone();
        let key = request_key(&leaf, &request_id);
        if self.requests.contains_key(&key) || self.pending.contains_key(&key) {
            return PromiseOrValue::Value(Outcome::denied(Reason::DuplicateRequest));
        }
        let recipient = action.recipient().clone();
        let amount = action.amount();
        let mandates = match self.check(&path, &action, expected_revision) {
            Ok(mandates) => mandates,
            Err(reason) => {
                return PromiseOrValue::Value(self.deny(
                    &leaf,
                    &request_id,
                    &recipient,
                    amount,
                    reason,
                    None,
                    via,
                    client,
                ));
            }
        };
        let today = day_index(now);

        if let Some(threshold) = self.confirm_threshold(&mandates, &recipient) {
            if amount > threshold {
                let for_agent = self
                    .pending_keys
                    .iter()
                    .filter(|k| {
                        self.pending
                            .get(*k)
                            .map(|p| p.leaf == leaf)
                            .unwrap_or(false)
                    })
                    .count();
                if self.pending_keys.len() >= MAX_PENDING || for_agent >= MAX_PENDING_PER_AGENT {
                    return PromiseOrValue::Value(self.deny(
                        &leaf,
                        &request_id,
                        &recipient,
                        amount,
                        Reason::TooManyPending,
                        None,
                        via,
                        client,
                    ));
                }
                let mut expires_at = now + CONFIRM_WINDOW_NS;
                for agent_id in &mandates {
                    if let Some(m) = self.mandates.get(agent_id) {
                        if let Some(t) = m.expires_at {
                            expires_at = expires_at.min(t);
                        }
                        if let Some(t) = m.recipients.get(&recipient).and_then(|r| r.expires_at) {
                            expires_at = expires_at.min(t);
                        }
                    }
                }
                self.reserve(&mandates, &recipient, today, amount);
                self.pending.insert(
                    key.clone(),
                    PendingConfirmation {
                        leaf: leaf.clone(),
                        request_id: request_id.clone(),
                        recipient: recipient.clone(),
                        amount: U128(amount),
                        day: today,
                        created_at: now,
                        expires_at,
                        path,
                        mandates,
                        via: via.clone(),
                        client: client.clone(),
                    },
                );
                self.pending_keys.push(key);
                self.record_activity(
                    &leaf,
                    &request_id,
                    &recipient,
                    amount,
                    "awaiting",
                    None,
                    via,
                    client,
                );
                PolicyEvent::PaymentAwaitingConfirmation {
                    leaf,
                    request_id: request_id.clone(),
                    recipient,
                    amount: U128(amount),
                    expires_at,
                }
                .emit();
                return PromiseOrValue::Value(Outcome::AwaitingConfirmation {
                    request_id,
                    expires_at,
                });
            }
        }

        self.reserve(&mandates, &recipient, today, amount);
        self.store_in_flight(
            key.clone(),
            leaf.clone(),
            request_id.clone(),
            recipient.clone(),
            amount,
            today,
            mandates,
            via,
            client,
        );
        PolicyEvent::PaymentReserved {
            leaf,
            request_id,
            recipient: recipient.clone(),
            amount: U128(amount),
        }
        .emit();

        Promise::new(recipient)
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_SETTLE)
                    .on_settle(key),
            )
            .into()
    }

    #[allow(clippy::too_many_arguments)]
    fn store_in_flight(
        &mut self,
        key: String,
        leaf: AgentId,
        request_id: String,
        recipient: AccountId,
        amount: u128,
        day: u64,
        mandates: Vec<AgentId>,
        via: Option<Via>,
        client: Option<String>,
    ) {
        self.requests.insert(
            key.clone(),
            Request {
                leaf,
                request_id,
                recipient,
                amount: U128(amount),
                day,
                created_at: env::block_timestamp(),
                status: RequestStatus::Pending,
                mandates,
                via,
                client,
            },
        );
        self.queue.insert(self.queue_tail, key);
        self.queue_tail += 1;
    }

    /// Records a denial and returns it.
    #[allow(clippy::too_many_arguments)]
    fn deny(
        &mut self,
        leaf: &str,
        request_id: &str,
        recipient: &AccountId,
        amount: u128,
        reason: Reason,
        detail: Option<String>,
        via: Option<Via>,
        client: Option<String>,
    ) -> Outcome {
        self.record_activity(
            leaf,
            request_id,
            recipient,
            amount,
            "denied",
            Some(reason),
            via,
            client,
        );
        PolicyEvent::PaymentDenied {
            leaf: leaf.to_string(),
            request_id: request_id.to_string(),
            reason,
        }
        .emit();
        Outcome::Denied { reason, detail }
    }

    /// Rechecks a waiting payment at confirmation time. Caps are not checked
    /// again: they were reserved on the original day.
    fn recheck(&self, pending: &PendingConfirmation, path: &[PathNode]) -> Result<(), Reason> {
        if self.paused {
            return Err(Reason::PaymentsPaused);
        }
        if self.blocked.contains_key(&pending.recipient) {
            return Err(Reason::RecipientBlocked);
        }
        let now = env::block_timestamp();
        for agent_id in &pending.mandates {
            let i = path
                .iter()
                .position(|n| &n.agent_id == agent_id)
                .ok_or(Reason::MandateStale)?;
            let mandate = self.mandates.get(agent_id).ok_or(Reason::NoMandate)?;
            if mandate.status == MandateStatus::Revoked {
                return Err(Reason::MandateRevoked);
            }
            if mandate.path.as_slice() != &path[..=i] {
                return Err(Reason::MandateStale);
            }
            if expired(mandate.expires_at, now) {
                return Err(Reason::MandateExpired);
            }
            let rule = mandate
                .recipients
                .get(&pending.recipient)
                .ok_or(Reason::RecipientNotApproved)?;
            if expired(rule.expires_at, now) {
                return Err(Reason::RecipientRuleExpired);
            }
        }
        // This payment is already inside `reserved_total`.
        if self.spendable_balance() < self.reserved_total {
            return Err(Reason::InsufficientBalance);
        }
        Ok(())
    }

    /// Ends a waiting payment without sending it: releases the reservation and
    /// keeps a finished record so its request ID stays used.
    fn finish_pending(&mut self, key: &str, status: RequestStatus, reason: Reason) -> Outcome {
        let pending = self
            .pending
            .remove(key)
            .unwrap_or_else(|| env::panic_str("No payment is waiting with this request ID"));
        self.pending_keys.retain(|k| k != key);
        let amount = pending.amount.0;
        self.release_reservation(&pending.mandates, &pending.recipient, pending.day, amount);
        let label = if status == RequestStatus::Expired {
            "expired"
        } else {
            "declined"
        };
        self.record_activity(
            &pending.leaf,
            &pending.request_id,
            &pending.recipient,
            amount,
            label,
            Some(reason),
            pending.via.clone(),
            pending.client.clone(),
        );
        PolicyEvent::PaymentDeclined {
            leaf: pending.leaf.clone(),
            request_id: pending.request_id.clone(),
            reason,
        }
        .emit();
        self.requests.insert(
            key.to_string(),
            Request {
                leaf: pending.leaf,
                request_id: pending.request_id,
                recipient: pending.recipient,
                amount: pending.amount,
                day: pending.day,
                created_at: env::block_timestamp(),
                status,
                mandates: pending.mandates,
                via: pending.via,
                client: pending.client,
            },
        );
        self.queue.insert(self.queue_tail, key.to_string());
        self.queue_tail += 1;
        Outcome::denied(reason)
    }

    /// Expires up to `EXPIRE_PER_CALL` overdue confirmations, so no keeper is needed.
    fn expire_overdue(&mut self, now: u64) {
        let overdue: Vec<String> = self
            .pending_keys
            .iter()
            .filter(|k| {
                self.pending
                    .get(*k)
                    .map(|p| p.expires_at <= now)
                    .unwrap_or(false)
            })
            .take(EXPIRE_PER_CALL)
            .cloned()
            .collect();
        for key in overdue {
            self.finish_pending(&key, RequestStatus::Expired, Reason::ConfirmationExpired);
        }
    }

    fn settle(&mut self, key: &str, success: bool) -> Outcome {
        let request = self
            .requests
            .get(key)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Unknown request"));
        match request.status {
            RequestStatus::Settled => {
                return Outcome::Settled {
                    request_id: request.request_id,
                }
            }
            RequestStatus::Failed => {
                return Outcome::Failed {
                    request_id: request.request_id,
                }
            }
            RequestStatus::Declined | RequestStatus::Expired => {
                return Outcome::denied(Reason::InvalidRequest)
            }
            RequestStatus::Pending => {}
        }
        let amount = request.amount.0;
        if success {
            self.reserved_total = self.reserved_total.saturating_sub(amount);
        } else {
            self.release_reservation(&request.mandates, &request.recipient, request.day, amount);
        }
        let status = if success {
            RequestStatus::Settled
        } else {
            RequestStatus::Failed
        };
        self.requests.get_mut(key).unwrap().status = status;
        let label = if success { "settled" } else { "failed" };
        self.record_activity(
            &request.leaf,
            &request.request_id,
            &request.recipient,
            amount,
            label,
            None,
            request.via.clone(),
            request.client.clone(),
        );
        if success {
            PolicyEvent::PaymentSettled {
                leaf: request.leaf,
                request_id: request.request_id.clone(),
            }
            .emit();
            Outcome::Settled {
                request_id: request.request_id,
            }
        } else {
            PolicyEvent::PaymentFailed {
                leaf: request.leaf,
                request_id: request.request_id.clone(),
            }
            .emit();
            Outcome::Failed {
                request_id: request.request_id,
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn record_activity(
        &mut self,
        leaf: &str,
        request_id: &str,
        recipient: &AccountId,
        amount: u128,
        outcome: &str,
        reason: Option<Reason>,
        via: Option<Via>,
        client: Option<String>,
    ) {
        let seq = self.activity_next;
        self.activity.insert(
            seq % ACTIVITY_SIZE,
            Activity {
                seq,
                at: env::block_timestamp(),
                leaf: leaf.to_string(),
                request_id: request_id.chars().take(64).collect(),
                recipient: recipient.clone(),
                amount: U128(amount),
                outcome: outcome.to_string(),
                reason,
                via,
                client,
            },
        );
        self.activity_next += 1;
    }

    /// Removes up to `PRUNE_PER_CALL` finished requests older than the retention window.
    fn prune(&mut self, now: u64) {
        for _ in 0..PRUNE_PER_CALL {
            if self.queue_head >= self.queue_tail {
                return;
            }
            let Some(key) = self.queue.get(&self.queue_head).cloned() else {
                return;
            };
            if let Some(request) = self.requests.get(&key) {
                if request.status == RequestStatus::Pending
                    || request.created_at + REQUEST_RETENTION_NS > now
                {
                    return;
                }
                self.requests.remove(&key);
            }
            self.queue.remove(&self.queue_head);
            self.queue_head += 1;
        }
    }
}

#[cfg(test)]
mod tests;
