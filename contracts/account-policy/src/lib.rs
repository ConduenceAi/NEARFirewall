//! NEARFirewall account policy.
//!
//! This contract is deployed on the payer's own NEAR account. It accepts payment
//! requests routed by the trusted registry, checks them against the owner's
//! mandates and recipient rules, reserves the amount, and sends native NEAR from
//! the account itself. Only the account (its own full-access keys, with 1
//! yoctoNEAR attached) can change the policy.

use std::collections::BTreeMap;

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};
use nearfirewall_types::{
    day_index, is_valid_request_id, AgentId, ExecContext, Outcome, PathNode, Reason, DAY_NS,
    MAX_DEPTH,
};

/// Maximum recipients one mandate can approve.
pub const MAX_RECIPIENTS: usize = 50;
/// Size of the activity ring buffer.
pub const ACTIVITY_SIZE: u64 = 64;
/// How long settled request IDs are kept for duplicate detection.
pub const REQUEST_RETENTION_NS: u64 = 2 * DAY_NS;
/// How many expired request records each execution prunes.
pub const PRUNE_PER_CALL: u32 = 5;
/// Default balance kept untouchable for storage growth and fees: 0.5 NEAR.
pub const DEFAULT_SAFETY_BUFFER: u128 = 500_000_000_000_000_000_000_000;
const GAS_FOR_SETTLE: Gas = Gas::from_tgas(10);

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Mandates,
    Usage,
    Requests,
    Queue,
    Activity,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecipientRule {
    pub per_payment_cap: U128,
    pub daily_cap: U128,
    pub expires_at: Option<u64>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct RecipientInput {
    pub recipient: AccountId,
    pub per_payment_cap: U128,
    pub daily_cap: U128,
    pub expires_at: Option<u64>,
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

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestStatus {
    Pending,
    Settled,
    Failed,
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
    /// `settled`, `failed`, or `denied`.
    pub outcome: String,
    pub reason: Option<Reason>,
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
    PaymentReserved {
        leaf: AgentId,
        request_id: String,
        recipient: AccountId,
        amount: U128,
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
}

fn request_key(leaf: &str, request_id: &str) -> String {
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
        }
    }

    // ---------------------------------------------------------------- owner writes

    /// Creates or replaces the mandate for `agent_id`, with its initial recipients.
    /// `path` is the agent's path from the registry (`get_path`), root first.
    #[payable]
    pub fn set_mandate(
        &mut self,
        agent_id: AgentId,
        path: Vec<PathNode>,
        daily_cap: U128,
        expires_at: Option<u64>,
        fixed: bool,
        recipients: Vec<RecipientInput>,
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

    /// Adds or replaces one recipient rule on an active, editable mandate.
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
        };
        validate_rule(&env::current_account_id(), &input);
        let mandate = self.editable_mandate(&agent_id);
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

    // ---------------------------------------------------------------- execution

    /// Called by the trusted registry with an authenticated request.
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
        let now = env::block_timestamp();
        self.prune(now);

        let leaf = ctx.leaf().agent_id.clone();
        let key = request_key(&leaf, &ctx.request_id);
        if self.requests.contains_key(&key) {
            return PromiseOrValue::Value(Outcome::denied(Reason::DuplicateRequest));
        }

        let recipient = ctx.action.recipient().clone();
        let amount = ctx.action.amount();
        let mandates = match self.check(&ctx) {
            Ok(mandates) => mandates,
            Err(reason) => {
                self.record_activity(
                    &leaf,
                    &ctx.request_id,
                    &recipient,
                    amount,
                    "denied",
                    Some(reason),
                );
                PolicyEvent::PaymentDenied {
                    leaf,
                    request_id: ctx.request_id,
                    reason,
                }
                .emit();
                return PromiseOrValue::Value(Outcome::denied(reason));
            }
        };

        let today = day_index(now);
        for agent_id in &mandates {
            self.add_usage(UsageKey::Mandate(agent_id.clone()), today, amount);
            self.add_usage(
                UsageKey::Recipient(agent_id.clone(), recipient.clone()),
                today,
                amount,
            );
        }
        self.add_usage(UsageKey::Account, today, amount);
        self.reserved_total += amount;

        self.requests.insert(
            key.clone(),
            Request {
                leaf: leaf.clone(),
                request_id: ctx.request_id.clone(),
                recipient: recipient.clone(),
                amount: U128(amount),
                day: today,
                created_at: now,
                status: RequestStatus::Pending,
                mandates,
            },
        );
        self.queue.insert(self.queue_tail, key.clone());
        self.queue_tail += 1;
        PolicyEvent::PaymentReserved {
            leaf,
            request_id: ctx.request_id,
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

    /// Records the transfer result. Idempotent.
    #[private]
    pub fn on_settle(&mut self, key: String) -> Outcome {
        // A transfer succeeds with an empty result; only `Failed` means the funds did not move.
        let success = env::promise_results_count() == 1
            && !matches!(
                env::promise_result_checked(0, 64),
                Err(PromiseError::Failed)
            );
        self.settle(&key, success)
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
        }
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

    /// Runs every payer-side check without changing state. The registry caller
    /// check is skipped, since views have no caller.
    pub fn preview(&self, ctx: ExecContext) -> Preview {
        if ctx.path.is_empty()
            || ctx.path.len() > MAX_DEPTH
            || !is_valid_request_id(&ctx.request_id)
        {
            return Preview {
                allowed: false,
                reason: Some(Reason::InvalidRequest),
                mandates: vec![],
            };
        }
        if self
            .requests
            .contains_key(&request_key(&ctx.leaf().agent_id, &ctx.request_id))
        {
            return Preview {
                allowed: false,
                reason: Some(Reason::DuplicateRequest),
                mandates: vec![],
            };
        }
        match self.check(&ctx) {
            Ok(mandates) => Preview {
                allowed: true,
                reason: None,
                mandates,
            },
            Err(reason) => Preview {
                allowed: false,
                reason: Some(reason),
                mandates: vec![],
            },
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

    fn available_balance(&self) -> u128 {
        let storage_cost =
            env::storage_byte_cost().as_yoctonear() * u128::from(env::storage_usage());
        env::account_balance()
            .as_yoctonear()
            .saturating_sub(storage_cost)
            .saturating_sub(self.reserved_total)
            .saturating_sub(self.safety_buffer)
    }

    /// Checks a request against the policy. Returns the agents whose mandates apply.
    fn check(&self, ctx: &ExecContext) -> Result<Vec<AgentId>, Reason> {
        if self.paused {
            return Err(Reason::PaymentsPaused);
        }
        if let Some(expected) = ctx.expected_revision {
            if expected != self.revision {
                return Err(Reason::RevisionMismatch);
            }
        }
        let now = env::block_timestamp();
        let today = day_index(now);
        let recipient = ctx.action.recipient();
        let amount = ctx.action.amount();
        if amount == 0 {
            return Err(Reason::InvalidRequest);
        }

        let mut applied = Vec::new();
        for (i, node) in ctx.path.iter().enumerate() {
            let Some(mandate) = self.mandates.get(&node.agent_id) else {
                continue;
            };
            if mandate.status == MandateStatus::Revoked {
                return Err(Reason::MandateRevoked);
            }
            if mandate.path.as_slice() != &ctx.path[..=i] {
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
            RequestStatus::Pending => {}
        }
        let amount = request.amount.0;
        self.reserved_total = self.reserved_total.saturating_sub(amount);
        let status = if success {
            RequestStatus::Settled
        } else {
            RequestStatus::Failed
        };
        if !success {
            for agent_id in &request.mandates {
                self.release_usage(UsageKey::Mandate(agent_id.clone()), request.day, amount);
                self.release_usage(
                    UsageKey::Recipient(agent_id.clone(), request.recipient.clone()),
                    request.day,
                    amount,
                );
            }
            self.release_usage(UsageKey::Account, request.day, amount);
        }
        self.requests.get_mut(key).unwrap().status = status;
        let label = if success { "settled" } else { "failed" };
        self.record_activity(
            &request.leaf,
            &request.request_id,
            &request.recipient,
            amount,
            label,
            None,
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

    fn record_activity(
        &mut self,
        leaf: &str,
        request_id: &str,
        recipient: &AccountId,
        amount: u128,
        outcome: &str,
        reason: Option<Reason>,
    ) {
        let seq = self.activity_next;
        self.activity.insert(
            seq % ACTIVITY_SIZE,
            Activity {
                seq,
                at: env::block_timestamp(),
                leaf: leaf.to_string(),
                request_id: request_id.to_string(),
                recipient: recipient.clone(),
                amount: U128(amount),
                outcome: outcome.to_string(),
                reason,
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
