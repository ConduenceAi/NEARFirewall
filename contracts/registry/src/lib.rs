//! NEARFirewall registry.
//!
//! Each user owns their own registry, deployed on a sub-account of their account
//! (`agents.<you>`), with themselves as `owner`. Only the owner registers agents.
//!
//! Every agent is a NEP-171 token. The token holder owns the agent. The
//! registry stores each agent's executor, capabilities, expiry, locks, place in
//! the agent tree, and records, and routes typed requests from an agent's
//! executor to the payer's account policy contract.
//!
//! The token carries ownership only. Every transfer and executor change advances
//! the agent's generation, and payer mandates are bound to the generations along
//! the agent's path, so a new holder starts with no spending authority.

// Contract methods take named JSON arguments, so long parameter lists are expected.
#![allow(clippy::too_many_arguments)]

use std::collections::HashMap;

use near_contract_standards::non_fungible_token::approval::NonFungibleTokenApproval;
use near_contract_standards::non_fungible_token::core::{
    NonFungibleTokenCore, NonFungibleTokenResolver,
};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::events::NftBurn;
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_sdk::json_types::{U128, U64};
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseOrValue,
};
use nearfirewall_types::{
    is_valid_request_id, Action, AgentId, Authorization, Capabilities, ExecContext, Outcome,
    PathNode, Reason, MAX_DEPTH,
};

/// The token cannot be transferred or approved for transfer.
pub const LOCK_NO_TRANSFER: u32 = 1 << 0;
/// The agent's capability rules can only narrow.
pub const LOCK_NO_CAPABILITY_RAISE: u32 = 1 << 1;
/// Locks supported by this release.
pub const SUPPORTED_LOCKS: u32 = LOCK_NO_TRANSFER | LOCK_NO_CAPABILITY_RAISE;

pub const MAX_CHILDREN: usize = 100;
pub const MAX_RECORDS: usize = 64;
pub const MAX_RECORD_VALUE_BYTES: usize = 1024;
pub const MAX_RECORD_NAME_BYTES: usize = 64;
pub const MAX_NAMESPACE_BYTES: usize = 32;
pub const MAX_DESCRIPTION_BYTES: usize = 512;
/// Registry-side outcomes kept per agent.
pub const ACTIVITY_SIZE: u64 = 32;
/// Storage reserved at registration for the activity ring buffer.
pub const ACTIVITY_RESERVE_BYTES: u64 = ACTIVITY_SIZE * 220;
const GAS_FOR_POLICY: Gas = Gas::from_tgas(40);

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Owners,
    TokenMetadata,
    Enumeration,
    Approvals,
    Agents,
    Handles,
    Children,
    RecordKeys,
    Records,
    Activity,
}

#[near(serializers = [borsh, json])]
#[serde(tag = "state", rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Active,
    /// `by_depth` is the depth of the holder who paused it. Only a holder at
    /// that depth or above can resume.
    Paused {
        by_depth: u8,
    },
    Removed,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct AgentRecord {
    pub handle: String,
    pub parent: Option<AgentId>,
    /// Root first, excluding the agent itself. Fixed at creation.
    pub ancestors: Vec<AgentId>,
    /// Account allowed to call `execute` for this agent. `None` for agents that
    /// act only through connection keys on the owner's account.
    pub executor: Option<AccountId>,
    pub capabilities: Capabilities,
    pub status: Status,
    pub expires_at: Option<u64>,
    pub locks: u32,
    pub generation: u64,
    pub created_at: u64,
    pub activity_next: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct AgentView {
    pub agent_id: AgentId,
    pub handle: String,
    pub holder: Option<AccountId>,
    pub parent: Option<AgentId>,
    pub ancestors: Vec<AgentId>,
    pub depth: u8,
    pub executor: Option<AccountId>,
    pub capabilities: Capabilities,
    pub status: Status,
    pub expires_at: Option<U64>,
    pub locks: u32,
    pub generation: U64,
    pub created_at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct RegistryActivity {
    pub seq: u64,
    pub at: u64,
    pub payer: AccountId,
    pub request_id: String,
    pub action: Action,
    /// `routed` or `denied`.
    pub outcome: String,
    pub reason: Option<Reason>,
}

#[near(serializers = [json])]
pub struct RecordEntry {
    pub key: String,
    pub value: String,
}

#[near(event_json(standard = "nearfirewall"))]
pub enum RegistryEvent {
    #[event_version("1.0.0")]
    AgentRegistered {
        agent_id: AgentId,
        handle: String,
        holder: AccountId,
        executor: Option<AccountId>,
        parent: Option<AgentId>,
        generation: u64,
    },
    #[event_version("1.0.0")]
    ExecutorChanged {
        agent_id: AgentId,
        executor: Option<AccountId>,
        generation: u64,
    },
    #[event_version("1.0.0")]
    GenerationAdvanced { agent_id: AgentId, generation: u64 },
    #[event_version("1.0.0")]
    AgentPaused { agent_id: AgentId, by_depth: u8 },
    #[event_version("1.0.0")]
    AgentResumed { agent_id: AgentId },
    #[event_version("1.0.0")]
    AgentRemoved { agent_id: AgentId },
    #[event_version("1.0.0")]
    CapabilitiesSet { agent_id: AgentId },
    #[event_version("1.0.0")]
    ExpiryExtended {
        agent_id: AgentId,
        expires_at: Option<u64>,
    },
    #[event_version("1.0.0")]
    LocksBurned { agent_id: AgentId, locks: u32 },
    #[event_version("1.0.0")]
    RecordSet { agent_id: AgentId, key: String },
    #[event_version("1.0.0")]
    RecordRemoved { agent_id: AgentId, key: String },
    #[event_version("1.0.0")]
    ExecutionRouted {
        agent_id: AgentId,
        payer: AccountId,
        request_id: String,
    },
    #[event_version("1.0.0")]
    ExecutionDenied {
        agent_id: AgentId,
        payer: AccountId,
        request_id: String,
        reason: Reason,
    },
}

#[ext_contract(ext_policy)]
pub trait PayerPolicy {
    fn on_execute(&mut self, ctx: ExecContext) -> PromiseOrValue<Outcome>;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    /// The account that owns this registry and whose payment policy trusts it.
    owner: AccountId,
    tokens: NonFungibleToken,
    agents: LookupMap<AgentId, AgentRecord>,
    handles: LookupMap<String, AgentId>,
    children: LookupMap<AgentId, Vec<AgentId>>,
    record_keys: LookupMap<AgentId, Vec<String>>,
    records: LookupMap<(AgentId, String), String>,
    activity: LookupMap<(AgentId, u64), RegistryActivity>,
    next_id: u64,
    next_generation: u64,
}

// ------------------------------------------------------------------ validation

fn validate_label(label: &str) {
    let ok = (2..=32).contains(&label.len())
        && label
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !label.starts_with('-')
        && !label.ends_with('-');
    require!(ok, "A handle label must be 2-32 characters of a-z, 0-9 and '-', not starting or ending with '-'");
}

fn validate_record_key(key: &str) {
    let Some((namespace, name)) = key.split_once('.') else {
        env::panic_str("A record key must be <namespace>.<name>");
    };
    let namespace_ok = (1..=MAX_NAMESPACE_BYTES).contains(&namespace.len())
        && namespace
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    let name_ok = (1..=MAX_RECORD_NAME_BYTES).contains(&name.len())
        && name.bytes().all(|b| b.is_ascii_graphic());
    require!(
        namespace_ok,
        "A record namespace must be 1-32 characters of a-z, 0-9 and '-'"
    );
    require!(name_ok, "A record name must be 1-64 printable characters");
}

fn expired(expires_at: Option<u64>, now: u64) -> bool {
    matches!(expires_at, Some(t) if t <= now)
}

/// True when `inner` ends no later than `outer`. `None` means no expiry.
fn expiry_within(inner: Option<u64>, outer: Option<u64>) -> bool {
    match (inner, outer) {
        (_, None) => true,
        (None, Some(_)) => false,
        (Some(i), Some(o)) => i <= o,
    }
}

/// Refunds the unused deposit after charging for storage growth, or refunds
/// freed storage when usage shrank.
fn settle_storage(initial: u64, reserved_bytes: u64) {
    let price = env::storage_byte_cost().as_yoctonear();
    let attached = env::attached_deposit().as_yoctonear();
    let used = env::storage_usage() + reserved_bytes;
    let refund = if used >= initial {
        let cost = u128::from(used - initial) * price;
        require!(
            attached >= cost,
            format!("Attach at least {cost} yoctoNEAR to cover storage")
        );
        attached - cost
    } else {
        attached + u128::from(initial - used) * price
    };
    if refund > 1 {
        Promise::new(env::predecessor_account_id())
            .transfer(NearToken::from_yoctonear(refund))
            .detach();
    }
}

#[near]
impl Registry {
    /// Creates a registry owned by `owner`. Called by the owner in the same
    /// transaction that creates `agents.<owner>` and deploys this code.
    #[init]
    pub fn new(owner: AccountId) -> Self {
        require!(
            env::predecessor_account_id() == owner,
            "Only the owner can initialize their registry"
        );
        require!(
            owner != env::current_account_id(),
            "The registry cannot own itself"
        );
        Self {
            owner: owner.clone(),
            tokens: NonFungibleToken::new(
                StorageKey::Owners,
                owner,
                Some(StorageKey::TokenMetadata),
                Some(StorageKey::Enumeration),
                Some(StorageKey::Approvals),
            ),
            agents: LookupMap::new(StorageKey::Agents),
            handles: LookupMap::new(StorageKey::Handles),
            children: LookupMap::new(StorageKey::Children),
            record_keys: LookupMap::new(StorageKey::RecordKeys),
            records: LookupMap::new(StorageKey::Records),
            activity: LookupMap::new(StorageKey::Activity),
            next_id: 1,
            next_generation: 1,
        }
    }

    // ------------------------------------------------------------ agents and tree

    /// Registers a top-level agent and mints its token to the owner. Owner only.
    #[payable]
    pub fn register_agent(
        &mut self,
        handle: String,
        executor: Option<AccountId>,
        capabilities: Capabilities,
        expires_at: Option<u64>,
        locks: Option<u32>,
        description: Option<String>,
    ) -> AgentView {
        let initial = env::storage_usage();
        validate_label(&handle);
        let holder = env::predecessor_account_id();
        require!(
            holder == self.owner,
            "Only the registry's owner can register agents"
        );
        let id = self.mint(
            handle,
            holder,
            None,
            vec![],
            executor,
            capabilities,
            expires_at,
            locks,
            description,
        );
        settle_storage(initial, ACTIVITY_RESERVE_BYTES);
        self.view(&id)
    }

    /// Creates a child agent under `parent_id`. The child is minted to the
    /// parent's holder. Its capabilities and expiry must fit inside the parent's.
    #[payable]
    pub fn create_child(
        &mut self,
        parent_id: AgentId,
        label: String,
        executor: Option<AccountId>,
        capabilities: Capabilities,
        expires_at: Option<u64>,
        locks: Option<u32>,
        description: Option<String>,
    ) -> AgentView {
        let initial = env::storage_usage();
        validate_label(&label);
        let parent = self.agent(&parent_id).clone();
        self.require_authority(&parent_id, &parent);
        require!(
            parent.status != Status::Removed,
            "The parent agent was removed"
        );
        require!(
            parent.ancestors.len() + 2 <= MAX_DEPTH,
            "The agent tree cannot be deeper than 8 levels"
        );
        require!(
            capabilities.is_within(&parent.capabilities),
            "A child cannot be wider than its parent"
        );
        require!(
            expiry_within(expires_at, parent.expires_at),
            "A child cannot expire later than its parent"
        );
        let siblings = self.children.get(&parent_id).map(|c| c.len()).unwrap_or(0);
        require!(siblings < MAX_CHILDREN, "Too many children");
        let holder = self
            .holder(&parent_id)
            .unwrap_or_else(|| env::panic_str("The parent agent has no holder"));

        let handle = format!("{label}.{}", parent.handle);
        let mut ancestors = parent.ancestors.clone();
        ancestors.push(parent_id.clone());
        let id = self.mint(
            handle,
            holder,
            Some(parent_id.clone()),
            ancestors,
            executor,
            capabilities,
            expires_at,
            locks,
            description,
        );
        self.children.entry(parent_id).or_default().push(id.clone());
        settle_storage(initial, ACTIVITY_RESERVE_BYTES);
        self.view(&id)
    }

    /// Changes the executor. Advances the generation.
    #[payable]
    pub fn set_executor(&mut self, agent_id: AgentId, executor: Option<AccountId>) {
        assert_one_yocto();
        let record = self.agent(&agent_id).clone();
        self.require_authority(&agent_id, &record);
        self.require_not_removed(&record);
        if let Some(executor) = &executor {
            self.validate_executor(executor, &env::predecessor_account_id());
        }
        let generation = self.take_generation();
        let record = self.agent_mut(&agent_id);
        record.executor = executor.clone();
        record.generation = generation;
        RegistryEvent::ExecutorChanged {
            agent_id,
            executor,
            generation,
        }
        .emit();
    }

    /// Pauses an agent and, with it, every agent below it.
    #[payable]
    pub fn pause(&mut self, agent_id: AgentId) {
        assert_one_yocto();
        let record = self.agent(&agent_id).clone();
        let depth = self.require_authority(&agent_id, &record);
        self.require_not_removed(&record);
        let by_depth = match record.status {
            Status::Paused { by_depth } => by_depth.min(depth),
            _ => depth,
        };
        self.agent_mut(&agent_id).status = Status::Paused { by_depth };
        RegistryEvent::AgentPaused { agent_id, by_depth }.emit();
    }

    /// Resumes an agent. A holder deeper in the tree cannot resume a pause set
    /// by an ancestor's holder.
    #[payable]
    pub fn resume(&mut self, agent_id: AgentId) {
        assert_one_yocto();
        let record = self.agent(&agent_id).clone();
        let depth = self.require_authority(&agent_id, &record);
        let Status::Paused { by_depth } = record.status else {
            env::panic_str("The agent is not paused");
        };
        require!(
            depth <= by_depth,
            "Only a holder at or above the pausing level can resume"
        );
        self.agent_mut(&agent_id).status = Status::Active;
        RegistryEvent::AgentResumed { agent_id }.emit();
    }

    /// Replaces the agent's capability rules. They must fit inside the parent's,
    /// and only narrow once `NO_CAPABILITY_RAISE` is burned.
    #[payable]
    pub fn set_capabilities(&mut self, agent_id: AgentId, capabilities: Capabilities) {
        assert_one_yocto();
        let record = self.agent(&agent_id).clone();
        self.require_authority(&agent_id, &record);
        self.require_not_removed(&record);
        if let Some(parent_id) = &record.parent {
            require!(
                capabilities.is_within(&self.agent(parent_id).capabilities),
                "A child cannot be wider than its parent"
            );
        }
        if record.locks & LOCK_NO_CAPABILITY_RAISE != 0 {
            require!(
                capabilities.is_within(&record.capabilities),
                "This agent's capabilities can only narrow"
            );
        }
        self.agent_mut(&agent_id).capabilities = capabilities;
        RegistryEvent::CapabilitiesSet { agent_id }.emit();
    }

    /// Extends the expiry. Expiry never moves earlier; pause or remove instead.
    #[payable]
    pub fn extend_expiry(&mut self, agent_id: AgentId, expires_at: Option<u64>) {
        assert_one_yocto();
        let record = self.agent(&agent_id).clone();
        self.require_authority(&agent_id, &record);
        self.require_not_removed(&record);
        require!(
            expiry_within(record.expires_at, expires_at),
            "Expiry can only be extended"
        );
        if let Some(parent_id) = &record.parent {
            require!(
                expiry_within(expires_at, self.agent(parent_id).expires_at),
                "A child cannot expire later than its parent"
            );
        }
        self.agent_mut(&agent_id).expires_at = expires_at;
        RegistryEvent::ExpiryExtended {
            agent_id,
            expires_at,
        }
        .emit();
    }

    /// Burns one-way locks. Locks cannot be cleared.
    #[payable]
    pub fn burn_locks(&mut self, agent_id: AgentId, locks: u32) {
        assert_one_yocto();
        require!(
            locks != 0 && locks & !SUPPORTED_LOCKS == 0,
            "Unsupported lock"
        );
        let record = self.agent(&agent_id).clone();
        self.require_authority(&agent_id, &record);
        self.require_not_removed(&record);
        let combined = record.locks | locks;
        self.agent_mut(&agent_id).locks = combined;
        if locks & LOCK_NO_TRANSFER != 0 {
            if let Some(approvals) = self.tokens.approvals_by_id.as_mut() {
                approvals.remove(&agent_id);
            }
        }
        RegistryEvent::LocksBurned {
            agent_id,
            locks: combined,
        }
        .emit();
    }

    /// Removes an agent and burns its token. Its descendants stop working.
    /// The handle and ID stay reserved forever.
    #[payable]
    pub fn remove_agent(&mut self, agent_id: AgentId) {
        assert_one_yocto();
        let initial = env::storage_usage();
        let record = self.agent(&agent_id).clone();
        self.require_authority(&agent_id, &record);
        self.require_not_removed(&record);
        self.burn(&agent_id);
        self.agent_mut(&agent_id).status = Status::Removed;
        RegistryEvent::AgentRemoved { agent_id }.emit();
        settle_storage(initial, 0);
    }

    // ------------------------------------------------------------ records

    /// Sets a record. Only the token holder can write records in this release.
    #[payable]
    pub fn set_record(&mut self, agent_id: AgentId, key: String, value: String) {
        let initial = env::storage_usage();
        validate_record_key(&key);
        require!(
            value.len() <= MAX_RECORD_VALUE_BYTES,
            "A record value can be at most 1 KB"
        );
        let record = self.agent(&agent_id).clone();
        self.require_not_removed(&record);
        require!(
            self.holder(&agent_id).as_ref() == Some(&env::predecessor_account_id()),
            "Only the holder can write records"
        );
        let keys = self.record_keys.entry(agent_id.clone()).or_default();
        if !keys.contains(&key) {
            require!(keys.len() < MAX_RECORDS, "Too many records");
            keys.push(key.clone());
        }
        self.records.insert((agent_id.clone(), key.clone()), value);
        RegistryEvent::RecordSet { agent_id, key }.emit();
        settle_storage(initial, 0);
    }

    #[payable]
    pub fn remove_record(&mut self, agent_id: AgentId, key: String) {
        assert_one_yocto();
        let initial = env::storage_usage();
        require!(
            self.holder(&agent_id).as_ref() == Some(&env::predecessor_account_id()),
            "Only the holder can write records"
        );
        require!(
            self.records
                .remove(&(agent_id.clone(), key.clone()))
                .is_some(),
            "No such record"
        );
        if let Some(keys) = self.record_keys.get_mut(&agent_id) {
            keys.retain(|k| k != &key);
        }
        RegistryEvent::RecordRemoved { agent_id, key }.emit();
        settle_storage(initial, 0);
    }

    // ------------------------------------------------------------ execution

    /// Called by an agent's executor. Checks the agent and its whole path, then
    /// routes the request to the payer's account policy. The transaction's
    /// final value is the [`Outcome`].
    pub fn execute(
        &mut self,
        payer: AccountId,
        agent_id: AgentId,
        grant_id: Option<String>,
        action: Action,
        request_id: String,
        expected_revision: Option<u64>,
    ) -> PromiseOrValue<Outcome> {
        let Some(leaf) = self.agents.get(&agent_id).cloned() else {
            return PromiseOrValue::Value(Outcome::denied(Reason::AgentNotFound));
        };
        // Callers other than the executor learn nothing and write nothing.
        let caller = env::predecessor_account_id();
        if leaf.executor.as_ref() != Some(&caller) {
            return PromiseOrValue::Value(Outcome::denied(Reason::ExecutorMismatch));
        }
        let check = if !is_valid_request_id(&request_id) {
            Err(Outcome::denied(Reason::InvalidRequest))
        } else if grant_id.is_some() {
            Err(Outcome::denied_with(
                Reason::PayerNotAuthorized,
                "grants are not supported in this release",
            ))
        } else {
            self.check_path(&agent_id, &leaf, &payer, &action)
        };

        match check {
            Err(outcome) => {
                if let Outcome::Denied { reason, .. } = &outcome {
                    self.record_activity(
                        &agent_id,
                        &payer,
                        &request_id,
                        &action,
                        "denied",
                        Some(*reason),
                    );
                    RegistryEvent::ExecutionDenied {
                        agent_id,
                        payer,
                        request_id,
                        reason: *reason,
                    }
                    .emit();
                }
                PromiseOrValue::Value(outcome)
            }
            Ok(path) => {
                self.record_activity(&agent_id, &payer, &request_id, &action, "routed", None);
                RegistryEvent::ExecutionRouted {
                    agent_id,
                    payer: payer.clone(),
                    request_id: request_id.clone(),
                }
                .emit();
                let ctx = ExecContext {
                    path,
                    executor: caller,
                    action,
                    request_id,
                    expected_revision,
                };
                ext_policy::ext(payer)
                    .with_static_gas(GAS_FOR_POLICY)
                    .on_execute(ctx)
                    .into()
            }
        }
    }

    /// Called by the owner's payment policy when a connection key on the owner's
    /// account asks to pay. Runs the same checks as `execute` for the owner as
    /// payer and returns the agent's path, or why it is refused. Any other caller
    /// is refused and nothing is written.
    pub fn authorize(
        &mut self,
        agent_id: AgentId,
        action: Action,
        request_id: String,
    ) -> Authorization {
        if env::predecessor_account_id() != self.owner {
            return Authorization::Denied {
                reason: Reason::UntrustedCaller,
                detail: None,
            };
        }
        let Some(leaf) = self.agents.get(&agent_id).cloned() else {
            return Authorization::Denied {
                reason: Reason::AgentNotFound,
                detail: None,
            };
        };
        let payer = self.owner.clone();
        let check = if is_valid_request_id(&request_id) {
            self.check_path(&agent_id, &leaf, &payer, &action)
        } else {
            Err(Outcome::denied(Reason::InvalidRequest))
        };
        match check {
            Ok(path) => {
                self.record_activity(&agent_id, &payer, &request_id, &action, "routed", None);
                RegistryEvent::ExecutionRouted {
                    agent_id,
                    payer,
                    request_id,
                }
                .emit();
                Authorization::Allowed { path }
            }
            Err(outcome) => {
                let (reason, detail) = match outcome {
                    Outcome::Denied { reason, detail } => (reason, detail),
                    _ => (Reason::InvalidRequest, None),
                };
                self.record_activity(
                    &agent_id,
                    &payer,
                    &request_id,
                    &action,
                    "denied",
                    Some(reason),
                );
                RegistryEvent::ExecutionDenied {
                    agent_id,
                    payer,
                    request_id,
                    reason,
                }
                .emit();
                Authorization::Denied { reason, detail }
            }
        }
    }

    // ------------------------------------------------------------ views

    /// The account that owns this registry.
    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn get_agent(&self, agent_id: AgentId) -> Option<AgentView> {
        self.agents
            .contains_key(&agent_id)
            .then(|| self.view(&agent_id))
    }

    pub fn resolve(&self, handle: String) -> Option<AgentView> {
        self.handles.get(&handle).map(|id| self.view(id))
    }

    /// Root first, leaf last, with current generations.
    pub fn get_path(&self, agent_id: AgentId) -> Vec<PathNode> {
        let record = self.agent(&agent_id);
        record
            .ancestors
            .iter()
            .chain(std::iter::once(&agent_id))
            .map(|id| PathNode {
                agent_id: id.clone(),
                generation: self.agent(id).generation,
            })
            .collect()
    }

    pub fn get_children(
        &self,
        agent_id: AgentId,
        from_index: Option<u64>,
        limit: Option<u64>,
    ) -> Vec<AgentView> {
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(50).min(MAX_CHILDREN as u64) as usize;
        self.children
            .get(&agent_id)
            .map(|ids| {
                ids.iter()
                    .skip(from)
                    .take(limit)
                    .map(|id| self.view(id))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn get_record(&self, agent_id: AgentId, key: String) -> Option<String> {
        self.records.get(&(agent_id, key)).cloned()
    }

    pub fn get_records(
        &self,
        agent_id: AgentId,
        from_index: Option<u64>,
        limit: Option<u64>,
    ) -> Vec<RecordEntry> {
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(MAX_RECORDS as u64) as usize;
        self.record_keys
            .get(&agent_id)
            .map(|keys| {
                keys.iter()
                    .skip(from)
                    .take(limit)
                    .filter_map(|k| {
                        self.records
                            .get(&(agent_id.clone(), k.clone()))
                            .map(|v| RecordEntry {
                                key: k.clone(),
                                value: v.clone(),
                            })
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Newest first.
    pub fn get_activity(&self, agent_id: AgentId, limit: Option<u64>) -> Vec<RegistryActivity> {
        let Some(record) = self.agents.get(&agent_id) else {
            return vec![];
        };
        let end = record.activity_next;
        let start = end.saturating_sub(ACTIVITY_SIZE);
        (start..end)
            .rev()
            .take(limit.unwrap_or(ACTIVITY_SIZE).min(ACTIVITY_SIZE) as usize)
            .filter_map(|seq| {
                self.activity
                    .get(&(agent_id.clone(), seq % ACTIVITY_SIZE))
                    .filter(|a| a.seq == seq)
                    .cloned()
            })
            .collect()
    }
}

// -------------------------------------------------------------------- internals

impl Registry {
    fn agent(&self, agent_id: &AgentId) -> &AgentRecord {
        self.agents
            .get(agent_id)
            .unwrap_or_else(|| env::panic_str("Agent not found"))
    }

    fn agent_mut(&mut self, agent_id: &AgentId) -> &mut AgentRecord {
        self.agents
            .get_mut(agent_id)
            .unwrap_or_else(|| env::panic_str("Agent not found"))
    }

    fn holder(&self, agent_id: &AgentId) -> Option<AccountId> {
        self.tokens.owner_by_id.get(agent_id)
    }

    fn take_generation(&mut self) -> u64 {
        let generation = self.next_generation;
        self.next_generation += 1;
        generation
    }

    fn require_not_removed(&self, record: &AgentRecord) {
        require!(record.status != Status::Removed, "The agent was removed");
    }

    /// Depth of the shallowest node on the agent's path held by `account`.
    fn authority_depth(
        &self,
        account: &AccountId,
        agent_id: &AgentId,
        record: &AgentRecord,
    ) -> Option<u8> {
        record
            .ancestors
            .iter()
            .chain(std::iter::once(agent_id))
            .position(|id| self.holder(id).as_ref() == Some(account))
            .map(|d| d as u8)
    }

    fn require_authority(&self, agent_id: &AgentId, record: &AgentRecord) -> u8 {
        self.authority_depth(&env::predecessor_account_id(), agent_id, record)
            .unwrap_or_else(|| {
                env::panic_str("Only the holder of this agent or one of its ancestors can do this")
            })
    }

    fn validate_executor(&self, executor: &AccountId, holder: &AccountId) {
        require!(
            executor != holder,
            "The executor must be a separate account from the holder"
        );
        require!(
            executor != &env::current_account_id(),
            "The registry cannot be an executor"
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn mint(
        &mut self,
        handle: String,
        holder: AccountId,
        parent: Option<AgentId>,
        ancestors: Vec<AgentId>,
        executor: Option<AccountId>,
        capabilities: Capabilities,
        expires_at: Option<u64>,
        locks: Option<u32>,
        description: Option<String>,
    ) -> AgentId {
        let now = env::block_timestamp();
        let locks = locks.unwrap_or(0);
        require!(locks & !SUPPORTED_LOCKS == 0, "Unsupported lock");
        require!(!expired(expires_at, now), "Expiry must be in the future");
        require!(!self.handles.contains_key(&handle), "This handle is taken");
        require!(
            description
                .as_ref()
                .map(|d| d.len() <= MAX_DESCRIPTION_BYTES)
                .unwrap_or(true),
            "The description can be at most 512 bytes"
        );
        if let Some(executor) = &executor {
            self.validate_executor(executor, &holder);
            require!(
                executor != &env::predecessor_account_id(),
                "The executor must be a separate account from the caller"
            );
        }

        let id = self.next_id.to_string();
        self.next_id += 1;
        let generation = self.take_generation();
        let metadata = TokenMetadata {
            title: Some(handle.clone()),
            description,
            media: None,
            media_hash: None,
            copies: Some(1),
            issued_at: Some(now.to_string()),
            expires_at: expires_at.map(|t| t.to_string()),
            starts_at: None,
            updated_at: None,
            extra: None,
            reference: None,
            reference_hash: None,
        };
        self.tokens
            .internal_mint(id.clone(), holder.clone(), Some(metadata));
        self.handles.insert(handle.clone(), id.clone());
        self.agents.insert(
            id.clone(),
            AgentRecord {
                handle: handle.clone(),
                parent: parent.clone(),
                ancestors,
                executor: executor.clone(),
                capabilities,
                status: Status::Active,
                expires_at,
                locks,
                generation,
                created_at: now,
                activity_next: 0,
            },
        );
        RegistryEvent::AgentRegistered {
            agent_id: id.clone(),
            handle,
            holder,
            executor,
            parent,
            generation,
        }
        .emit();
        id
    }

    fn burn(&mut self, agent_id: &AgentId) {
        let Some(owner) = self.tokens.owner_by_id.remove(agent_id) else {
            return;
        };
        if let Some(metadata) = self.tokens.token_metadata_by_id.as_mut() {
            metadata.remove(agent_id);
        }
        if let Some(per_owner) = self.tokens.tokens_per_owner.as_mut() {
            if let Some(mut ids) = per_owner.get(&owner) {
                ids.remove(agent_id);
                if ids.is_empty() {
                    per_owner.remove(&owner);
                } else {
                    per_owner.insert(&owner, &ids);
                }
            }
        }
        if let Some(approvals) = self.tokens.approvals_by_id.as_mut() {
            approvals.remove(agent_id);
        }
        if let Some(next) = self.tokens.next_approval_id_by_id.as_mut() {
            next.remove(agent_id);
        }
        NftBurn {
            owner_id: &owner,
            token_ids: &[agent_id.as_str()],
            authorized_id: None,
            memo: None,
        }
        .emit();
    }

    /// Checks status, expiry, and capabilities of every node from root to leaf,
    /// and that the payer holds the requesting agent itself.
    ///
    /// Holding an ancestor is not enough: a payer's mandate on an ancestor does
    /// not track its descendants' generations, so a leaf transferred to someone
    /// else must not keep spending from the previous holder's branch budget.
    fn check_path(
        &self,
        agent_id: &AgentId,
        leaf: &AgentRecord,
        payer: &AccountId,
        action: &Action,
    ) -> Result<Vec<PathNode>, Outcome> {
        let now = env::block_timestamp();
        let mut path = Vec::with_capacity(leaf.ancestors.len() + 1);
        for id in leaf.ancestors.iter().chain(std::iter::once(agent_id)) {
            let is_leaf = id == agent_id;
            let node = self.agent(id);
            match node.status {
                Status::Removed => {
                    return Err(Outcome::denied(if is_leaf {
                        Reason::AgentRemoved
                    } else {
                        Reason::BranchRemoved
                    }))
                }
                Status::Paused { .. } => {
                    return Err(Outcome::denied(if is_leaf {
                        Reason::AgentPaused
                    } else {
                        Reason::BranchPaused
                    }))
                }
                Status::Active => {}
            }
            if expired(node.expires_at, now) {
                return Err(Outcome::denied(if is_leaf {
                    Reason::AgentExpired
                } else {
                    Reason::BranchExpired
                }));
            }
            if let Err(reason) = node.capabilities.allows(action) {
                return Err(if is_leaf {
                    Outcome::denied(reason)
                } else {
                    Outcome::denied_with(reason, format!("limited by agent {id}"))
                });
            }
            path.push(PathNode {
                agent_id: id.clone(),
                generation: node.generation,
            });
        }
        if self.holder(agent_id).as_ref() != Some(payer) {
            return Err(Outcome::denied(Reason::PayerNotAuthorized));
        }
        Ok(path)
    }

    fn record_activity(
        &mut self,
        agent_id: &AgentId,
        payer: &AccountId,
        request_id: &str,
        action: &Action,
        outcome: &str,
        reason: Option<Reason>,
    ) {
        let record = self.agent_mut(agent_id);
        let seq = record.activity_next;
        record.activity_next += 1;
        self.activity.insert(
            (agent_id.clone(), seq % ACTIVITY_SIZE),
            RegistryActivity {
                seq,
                at: env::block_timestamp(),
                payer: payer.clone(),
                // Bounded so the reserved storage always covers the slot.
                request_id: request_id.chars().take(64).collect(),
                action: action.clone(),
                outcome: outcome.to_string(),
                reason,
            },
        );
    }

    fn view(&self, agent_id: &AgentId) -> AgentView {
        let r = self.agent(agent_id);
        AgentView {
            agent_id: agent_id.clone(),
            handle: r.handle.clone(),
            holder: self.holder(agent_id),
            parent: r.parent.clone(),
            ancestors: r.ancestors.clone(),
            depth: r.ancestors.len() as u8,
            executor: r.executor.clone(),
            capabilities: r.capabilities.clone(),
            status: r.status,
            expires_at: r.expires_at.map(U64),
            locks: r.locks,
            generation: U64(r.generation),
            created_at: U64(r.created_at),
        }
    }

    fn before_transfer(&self, token_id: &TokenId, receiver_id: &AccountId) {
        let record = self.agent(token_id);
        require!(
            record.locks & LOCK_NO_TRANSFER == 0,
            "This agent is non-transferable"
        );
        require!(record.status != Status::Removed, "The agent was removed");
        require!(
            record.executor.as_ref() != Some(receiver_id),
            "An agent cannot be transferred to its own executor"
        );
    }

    fn advance_generation(&mut self, token_id: &TokenId) {
        let generation = self.take_generation();
        self.agent_mut(token_id).generation = generation;
        RegistryEvent::GenerationAdvanced {
            agent_id: token_id.clone(),
            generation,
        }
        .emit();
    }
}

// -------------------------------------------------------------------- NEP-171 and extensions

#[near]
impl NonFungibleTokenCore for Registry {
    #[payable]
    fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        self.before_transfer(&token_id, &receiver_id);
        self.tokens
            .nft_transfer(receiver_id, token_id.clone(), approval_id, memo);
        self.advance_generation(&token_id);
    }

    #[payable]
    fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        self.before_transfer(&token_id, &receiver_id);
        let result =
            self.tokens
                .nft_transfer_call(receiver_id, token_id.clone(), approval_id, memo, msg);
        self.advance_generation(&token_id);
        result
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id)
    }
}

#[near]
impl NonFungibleTokenResolver for Registry {
    #[private]
    fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        approved_account_ids: Option<HashMap<AccountId, u64>>,
    ) -> bool {
        let kept = self.tokens.nft_resolve_transfer(
            previous_owner_id,
            receiver_id,
            token_id.clone(),
            approved_account_ids,
        );
        if !kept && self.agents.contains_key(&token_id) {
            // The token went back to its previous holder: advance again so
            // nothing approved during the transfer survives.
            self.advance_generation(&token_id);
        }
        kept
    }
}

#[near]
impl NonFungibleTokenApproval for Registry {
    #[payable]
    fn nft_approve(
        &mut self,
        token_id: TokenId,
        account_id: AccountId,
        msg: Option<String>,
    ) -> Option<Promise> {
        let record = self.agent(&token_id);
        require!(
            record.locks & LOCK_NO_TRANSFER == 0,
            "This agent is non-transferable"
        );
        require!(
            record.executor.as_ref() != Some(&account_id),
            "An agent's executor cannot be approved for transfer"
        );
        self.tokens.nft_approve(token_id, account_id, msg)
    }

    #[payable]
    fn nft_revoke(&mut self, token_id: TokenId, account_id: AccountId) {
        self.tokens.nft_revoke(token_id, account_id)
    }

    #[payable]
    fn nft_revoke_all(&mut self, token_id: TokenId) {
        self.tokens.nft_revoke_all(token_id)
    }

    fn nft_is_approved(
        &self,
        token_id: TokenId,
        approved_account_id: AccountId,
        approval_id: Option<u64>,
    ) -> bool {
        self.tokens
            .nft_is_approved(token_id, approved_account_id, approval_id)
    }
}

#[near]
impl NonFungibleTokenEnumeration for Registry {
    fn nft_total_supply(&self) -> U128 {
        self.tokens.nft_total_supply()
    }

    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens(from_index, limit)
    }

    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.tokens.nft_supply_for_owner(account_id)
    }

    fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<Token> {
        self.tokens
            .nft_tokens_for_owner(account_id, from_index, limit)
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Registry {
    fn nft_metadata(&self) -> NFTContractMetadata {
        NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "NEARFirewall Agents".to_string(),
            symbol: "AGENT".to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }
}

#[cfg(test)]
mod tests;
