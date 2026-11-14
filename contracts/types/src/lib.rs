//! Types shared by the NEARFirewall registry and account policy contracts.
//!
//! Everything here crosses the contract boundary: the registry builds an
//! [`ExecContext`] and the payer's policy contract answers with an [`Outcome`].
//! Changing any type here changes both contracts and the TypeScript SDK.

use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

/// NEP-171 token ID of an agent: the decimal string of a sequential `u64`.
/// IDs are never reused.
pub type AgentId = String;

/// Maximum number of nodes on a path from a root agent to a leaf, inclusive.
pub const MAX_DEPTH: usize = 8;

/// Length of a request ID in bytes. Request IDs travel as lowercase hex.
pub const REQUEST_ID_BYTES: usize = 32;

/// Nanoseconds in one UTC day. Daily windows are `block_timestamp / DAY_NS`.
pub const DAY_NS: u64 = 86_400_000_000_000;

/// Returns the UTC day index for a block timestamp in nanoseconds.
pub fn day_index(timestamp_ns: u64) -> u64 {
    timestamp_ns / DAY_NS
}

/// Returns true when `id` is 64 lowercase hex characters.
pub fn is_valid_request_id(id: &str) -> bool {
    id.len() == REQUEST_ID_BYTES * 2
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A typed operation an agent can request.
#[near(serializers = [borsh, json])]
#[serde(tag = "type")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    /// Send native NEAR from the payer's account.
    TransferNear { recipient: AccountId, amount: U128 },
    /// Fund one x402 payment. The payer's policy checks `pay_to` (the seller) and
    /// `amount` (in the token's smallest unit) against its x402 rules, then moves
    /// exactly `amount` of `asset` from the payer's account to the connection's
    /// x402 payment account, which signs the seller's transfer. Appended after
    /// `TransferNear`: the enum is stored in Borsh, so never reorder.
    X402Pay {
        asset: AccountId,
        pay_to: AccountId,
        amount: U128,
    },
}

impl Action {
    pub fn amount(&self) -> u128 {
        match self {
            Action::TransferNear { amount, .. } | Action::X402Pay { amount, .. } => amount.0,
        }
    }

    /// Who is paid in the end: the NEAR recipient, or the x402 seller.
    pub fn recipient(&self) -> &AccountId {
        match self {
            Action::TransferNear { recipient, .. } => recipient,
            Action::X402Pay { pay_to, .. } => pay_to,
        }
    }

    pub fn is_x402(&self) -> bool {
        matches!(self, Action::X402Pay { .. })
    }
}

/// The largest x402 payment an agent may request, in the token's smallest unit
/// (USDC has 6 decimals). Stored apart from [`Capabilities`], which is part of
/// every stored agent record, so adding x402 does not change that layout.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapX402 {
    pub max_per_payment: U128,
}

impl CapX402 {
    /// Returns true when `inner` allows nothing that `outer` refuses.
    pub fn is_within(inner: Option<&CapX402>, outer: Option<&CapX402>) -> bool {
        match (inner, outer) {
            (None, _) => true,
            (Some(_), None) => false,
            (Some(inner), Some(outer)) => inner.max_per_payment.0 <= outer.max_per_payment.0,
        }
    }

    /// Checks one x402 amount against an agent's capability.
    pub fn allows(cap: Option<&CapX402>, amount: u128) -> Result<(), Reason> {
        match cap {
            None => Err(Reason::ActionNotAllowed),
            Some(cap) if amount > cap.max_per_payment.0 => Err(Reason::CapExceeded),
            Some(_) => Ok(()),
        }
    }
}

/// What an agent may request. A missing entry means the action is not allowed.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Capabilities {
    pub transfer_near: Option<CapTransferNear>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapTransferNear {
    pub max_per_payment: U128,
}

impl Capabilities {
    /// Returns true when every action allowed by `self` is also allowed by
    /// `outer`, with caps no higher. Used for "children only narrow".
    pub fn is_within(&self, outer: &Capabilities) -> bool {
        match (&self.transfer_near, &outer.transfer_near) {
            (None, _) => true,
            (Some(_), None) => false,
            (Some(inner), Some(outer)) => inner.max_per_payment.0 <= outer.max_per_payment.0,
        }
    }

    /// Checks one action against these capabilities.
    pub fn allows(&self, action: &Action) -> Result<(), Reason> {
        match action {
            Action::TransferNear { amount, .. } => match &self.transfer_near {
                None => Err(Reason::ActionNotAllowed),
                Some(cap) if amount.0 > cap.max_per_payment.0 => Err(Reason::CapExceeded),
                Some(_) => Ok(()),
            },
            // The registry checks x402 against the agent's separate `CapX402`.
            Action::X402Pay { .. } => Err(Reason::ActionNotAllowed),
        }
    }
}

/// One node on an agent's path, with the generation it had when the path was read.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PathNode {
    pub agent_id: AgentId,
    pub generation: u64,
}

/// Sent by the registry to the payer's `on_execute`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecContext {
    /// Root first, leaf last.
    pub path: Vec<PathNode>,
    pub executor: AccountId,
    pub action: Action,
    /// 32 bytes as lowercase hex, generated by the client.
    pub request_id: String,
    /// The payer's policy revision the agent expects, if it wants the check.
    pub expected_revision: Option<u64>,
}

impl ExecContext {
    pub fn leaf(&self) -> &PathNode {
        self.path.last().expect("path is never empty")
    }
}

/// Final result of an execution, returned as the transaction's value.
#[near(serializers = [borsh, json])]
#[serde(tag = "status", rename_all = "snake_case")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The transfer settled.
    Settled { request_id: String },
    /// The transfer was dispatched and failed. The reservation was released.
    Failed { request_id: String },
    /// A contract refused the request before any funds moved.
    Denied {
        reason: Reason,
        detail: Option<String>,
    },
    /// The amount is reserved and waits for the owner to confirm or decline it
    /// ("ask me first"). Nothing has moved yet.
    AwaitingConfirmation { request_id: String, expires_at: u64 },
}

/// The registry's answer when the owner's policy asks it to authorize an agent
/// (connection mode). `Allowed` carries the agent's path with generations.
#[near(serializers = [borsh, json])]
#[serde(tag = "status", rename_all = "snake_case")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Authorization {
    Allowed {
        path: Vec<PathNode>,
    },
    Denied {
        reason: Reason,
        detail: Option<String>,
    },
}

impl Outcome {
    pub fn denied(reason: Reason) -> Self {
        Outcome::Denied {
            reason,
            detail: None,
        }
    }

    pub fn denied_with(reason: Reason, detail: impl Into<String>) -> Self {
        Outcome::Denied {
            reason,
            detail: Some(detail.into()),
        }
    }
}

/// Reason codes. The JSON form is `SCREAMING_SNAKE_CASE`, such as `RECIPIENT_NOT_APPROVED`.
#[near(serializers = [borsh, json])]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    // Registry
    AgentNotFound,
    AgentRemoved,
    AgentPaused,
    AgentExpired,
    BranchPaused,
    BranchRemoved,
    BranchExpired,
    ExecutorMismatch,
    ActionNotAllowed,
    CapExceeded,
    PayerNotAuthorized,
    InvalidRequest,
    // Account policy
    UntrustedCaller,
    PaymentsPaused,
    DuplicateRequest,
    RevisionMismatch,
    NoMandate,
    MandateStale,
    MandateRevoked,
    MandateExpired,
    RecipientNotApproved,
    RecipientRuleExpired,
    PerPaymentCap,
    RecipientDailyCap,
    MandateDailyCap,
    AccountDailyCap,
    InsufficientBalance,
    // Connections and confirmations. Appended: never reorder, the enum is stored in Borsh.
    UnknownConnection,
    AuthorizationFailed,
    ConfirmationDeclined,
    ConfirmationExpired,
    TooManyPending,
    RecipientBlocked,
    // x402. Appended for the same reason.
    /// The payer has not turned x402 on, or an approval on the path has no x402 rules.
    X402NotEnabled,
    /// The seller asked for a token other than the payer's x402 token.
    AssetNotAccepted,
    /// The shared daily budget for sellers the owner has not listed is used up.
    UnlistedDailyCap,
}

impl Reason {
    /// The code as it appears in JSON and events.
    pub fn code(&self) -> &'static str {
        match self {
            Reason::AgentNotFound => "AGENT_NOT_FOUND",
            Reason::AgentRemoved => "AGENT_REMOVED",
            Reason::AgentPaused => "AGENT_PAUSED",
            Reason::AgentExpired => "AGENT_EXPIRED",
            Reason::BranchPaused => "BRANCH_PAUSED",
            Reason::BranchRemoved => "BRANCH_REMOVED",
            Reason::BranchExpired => "BRANCH_EXPIRED",
            Reason::ExecutorMismatch => "EXECUTOR_MISMATCH",
            Reason::ActionNotAllowed => "ACTION_NOT_ALLOWED",
            Reason::CapExceeded => "CAP_EXCEEDED",
            Reason::PayerNotAuthorized => "PAYER_NOT_AUTHORIZED",
            Reason::InvalidRequest => "INVALID_REQUEST",
            Reason::UntrustedCaller => "UNTRUSTED_CALLER",
            Reason::PaymentsPaused => "PAYMENTS_PAUSED",
            Reason::DuplicateRequest => "DUPLICATE_REQUEST",
            Reason::RevisionMismatch => "REVISION_MISMATCH",
            Reason::NoMandate => "NO_MANDATE",
            Reason::MandateStale => "MANDATE_STALE",
            Reason::MandateRevoked => "MANDATE_REVOKED",
            Reason::MandateExpired => "MANDATE_EXPIRED",
            Reason::RecipientNotApproved => "RECIPIENT_NOT_APPROVED",
            Reason::RecipientRuleExpired => "RECIPIENT_RULE_EXPIRED",
            Reason::PerPaymentCap => "PER_PAYMENT_CAP",
            Reason::RecipientDailyCap => "RECIPIENT_DAILY_CAP",
            Reason::MandateDailyCap => "MANDATE_DAILY_CAP",
            Reason::AccountDailyCap => "ACCOUNT_DAILY_CAP",
            Reason::InsufficientBalance => "INSUFFICIENT_BALANCE",
            Reason::UnknownConnection => "UNKNOWN_CONNECTION",
            Reason::AuthorizationFailed => "AUTHORIZATION_FAILED",
            Reason::ConfirmationDeclined => "CONFIRMATION_DECLINED",
            Reason::ConfirmationExpired => "CONFIRMATION_EXPIRED",
            Reason::TooManyPending => "TOO_MANY_PENDING",
            Reason::RecipientBlocked => "RECIPIENT_BLOCKED",
            Reason::X402NotEnabled => "X402_NOT_ENABLED",
            Reason::AssetNotAccepted => "ASSET_NOT_ACCEPTED",
            Reason::UnlistedDailyCap => "UNLISTED_DAILY_CAP",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(max: Option<u128>) -> Capabilities {
        Capabilities {
            transfer_near: max.map(|m| CapTransferNear {
                max_per_payment: U128(m),
            }),
        }
    }

    #[test]
    fn narrowing() {
        assert!(caps(Some(3)).is_within(&caps(Some(3))));
        assert!(caps(Some(2)).is_within(&caps(Some(3))));
        assert!(!caps(Some(4)).is_within(&caps(Some(3))));
        assert!(caps(None).is_within(&caps(None)));
        assert!(!caps(Some(1)).is_within(&caps(None)));
    }

    #[test]
    fn allows() {
        let action = |a| Action::TransferNear {
            recipient: "shop.testnet".parse().unwrap(),
            amount: U128(a),
        };
        assert_eq!(caps(Some(3)).allows(&action(3)), Ok(()));
        assert_eq!(caps(Some(3)).allows(&action(4)), Err(Reason::CapExceeded));
        assert_eq!(caps(None).allows(&action(1)), Err(Reason::ActionNotAllowed));
    }

    #[test]
    fn request_ids() {
        assert!(is_valid_request_id(&"ab".repeat(32)));
        assert!(!is_valid_request_id(&"AB".repeat(32)));
        assert!(!is_valid_request_id("abc"));
    }

    #[test]
    fn json_shapes() {
        let outcome = Outcome::denied(Reason::RecipientNotApproved);
        let json = near_sdk::serde_json::to_string(&outcome).unwrap();
        assert_eq!(
            json,
            r#"{"status":"denied","reason":"RECIPIENT_NOT_APPROVED","detail":null}"#
        );
        let action: Action = near_sdk::serde_json::from_str(
            r#"{"type":"TransferNear","recipient":"a.testnet","amount":"5"}"#,
        )
        .unwrap();
        assert_eq!(action.amount(), 5);
        let waiting = Outcome::AwaitingConfirmation {
            request_id: "ab".into(),
            expires_at: 5,
        };
        assert_eq!(
            near_sdk::serde_json::to_string(&waiting).unwrap(),
            r#"{"status":"awaiting_confirmation","request_id":"ab","expires_at":5}"#
        );
        let allowed = Authorization::Allowed {
            path: vec![PathNode {
                agent_id: "1".into(),
                generation: 2,
            }],
        };
        assert_eq!(
            near_sdk::serde_json::to_string(&allowed).unwrap(),
            r#"{"status":"allowed","path":[{"agent_id":"1","generation":2}]}"#
        );
        for reason in [
            Reason::BranchPaused,
            Reason::MandateDailyCap,
            Reason::InsufficientBalance,
            Reason::UnknownConnection,
            Reason::TooManyPending,
            Reason::RecipientBlocked,
            Reason::X402NotEnabled,
            Reason::AssetNotAccepted,
            Reason::UnlistedDailyCap,
        ] {
            let json = near_sdk::serde_json::to_string(&reason).unwrap();
            assert_eq!(json, format!("\"{}\"", reason.code()));
        }
    }

    #[test]
    fn x402_action_shape() {
        let action: Action = near_sdk::serde_json::from_str(
            r#"{"type":"X402Pay","asset":"usdc.testnet","pay_to":"seller.testnet","amount":"50000"}"#,
        )
        .unwrap();
        assert!(action.is_x402());
        assert_eq!(action.amount(), 50_000);
        assert_eq!(action.recipient().as_str(), "seller.testnet");
        // Existing NEAR capabilities never allow x402 on their own.
        assert_eq!(
            caps(Some(u128::MAX)).allows(&action),
            Err(Reason::ActionNotAllowed)
        );
        // Borsh keeps the original variant first, so stored NEAR actions still decode.
        let near = Action::TransferNear {
            recipient: "a.testnet".parse().unwrap(),
            amount: U128(1),
        };
        assert_eq!(near_sdk::borsh::to_vec(&near).unwrap()[0], 0);
        assert_eq!(near_sdk::borsh::to_vec(&action).unwrap()[0], 1);
    }

    #[test]
    fn x402_capability() {
        let cap = |m| CapX402 {
            max_per_payment: U128(m),
        };
        assert_eq!(CapX402::allows(Some(&cap(10)), 10), Ok(()));
        assert_eq!(
            CapX402::allows(Some(&cap(10)), 11),
            Err(Reason::CapExceeded)
        );
        assert_eq!(CapX402::allows(None, 1), Err(Reason::ActionNotAllowed));
        assert!(CapX402::is_within(None, None));
        assert!(CapX402::is_within(Some(&cap(5)), Some(&cap(5))));
        assert!(!CapX402::is_within(Some(&cap(6)), Some(&cap(5))));
        assert!(!CapX402::is_within(Some(&cap(1)), None));
    }
}
