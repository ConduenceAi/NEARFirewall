use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, PromiseResult};
use nearfirewall_types::Action;

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const T0: u64 = 20_000 * DAY_NS + 3_600_000_000_000; // 01:00 UTC on some day

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn alice() -> AccountId {
    acc("alice.testnet")
}
fn registry() -> AccountId {
    acc("registry.testnet")
}

fn set_env(predecessor: AccountId, deposit: u128, now: u64, balance_near: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(alice())
        .signer_account_id(predecessor.clone())
        .predecessor_account_id(predecessor)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(now)
        .storage_usage(10_000) // 0.1 NEAR of storage
        .account_balance(NearToken::from_yoctonear(balance_near * NEAR));
    testing_env!(b.build());
}

fn as_owner(now: u64) {
    set_env(alice(), 1, now, 100);
}

fn node(id: &str, generation: u64) -> PathNode {
    PathNode {
        agent_id: id.to_string(),
        generation,
    }
}

fn rule(recipient: &str, per: u128, daily: u128) -> RecipientInput {
    RecipientInput {
        recipient: acc(recipient),
        per_payment_cap: U128(per * NEAR),
        daily_cap: U128(daily * NEAR),
        expires_at: None,
        confirm_above: None,
    }
}

fn rid(n: u64) -> String {
    format!("{n:064x}")
}

fn new_policy() -> AccountPolicy {
    set_env(alice(), 0, T0, 100);
    AccountPolicy::initialize(registry(), None)
}

/// The README example: one agent, `vendor` at 3 per payment and 6 per day,
/// `vendor2` at 2 and 4, `vendor3` at 3 and 6, and a 10 NEAR agent budget.
fn readme_policy() -> AccountPolicy {
    let mut p = new_policy();
    as_owner(T0);
    p.set_mandate(
        "1".into(),
        vec![node("1", 10)],
        U128(10 * NEAR),
        None,
        false,
        vec![
            rule("vendor.testnet", 3, 6),
            rule("vendor2.testnet", 2, 4),
            rule("vendor3.testnet", 3, 6),
        ],
        None,
    );
    p
}

struct Run {
    path: Vec<PathNode>,
    now: u64,
    balance: u128,
    settle: Option<bool>,
    expected_revision: Option<u64>,
}

impl Default for Run {
    fn default() -> Self {
        Run {
            path: vec![node("1", 10)],
            now: T0,
            balance: 100,
            settle: Some(true),
            expected_revision: None,
        }
    }
}

fn exec_with(
    p: &mut AccountPolicy,
    run: Run,
    recipient: &str,
    amount_near: u128,
    request: u64,
) -> Outcome {
    set_env(registry(), 0, run.now, run.balance);
    let ctx = ExecContext {
        path: run.path.clone(),
        executor: acc("runner.testnet"),
        action: Action::TransferNear {
            recipient: acc(recipient),
            amount: U128(amount_near * NEAR),
        },
        request_id: rid(request),
        expected_revision: run.expected_revision,
    };
    match p.on_execute(ctx) {
        PromiseOrValue::Value(outcome) => outcome,
        PromiseOrValue::Promise(_) => {
            let key = request_key(&run.path.last().unwrap().agent_id, &rid(request));
            match run.settle {
                Some(success) => p.settle(&key, success),
                None => Outcome::Settled {
                    request_id: "pending".into(),
                },
            }
        }
    }
}

fn exec(p: &mut AccountPolicy, recipient: &str, amount_near: u128, request: u64) -> Outcome {
    exec_with(p, Run::default(), recipient, amount_near, request)
}

fn denied(reason: Reason) -> Outcome {
    Outcome::denied(reason)
}

fn settled(request: u64) -> Outcome {
    Outcome::Settled {
        request_id: rid(request),
    }
}

#[test]
#[should_panic(expected = "Only the account itself can initialize")]
fn initialize_requires_the_account_itself() {
    set_env(acc("mallory.testnet"), 0, T0, 100);
    AccountPolicy::initialize(registry(), None);
}

#[test]
#[should_panic(expected = "Only the account itself can change its policy")]
fn owner_writes_reject_other_callers() {
    let mut p = readme_policy();
    set_env(registry(), 1, T0, 100);
    p.pause();
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn owner_writes_require_one_yocto() {
    let mut p = readme_policy();
    set_env(alice(), 0, T0, 100);
    p.pause();
}

#[test]
fn readme_example() {
    let mut p = readme_policy();
    assert_eq!(exec(&mut p, "vendor.testnet", 2, 1), settled(1));
    assert_eq!(
        exec(&mut p, "vendor.testnet", 4, 2),
        denied(Reason::PerPaymentCap)
    );
    assert_eq!(
        exec(&mut p, "stranger.testnet", 1, 3),
        denied(Reason::RecipientNotApproved)
    );
}

#[test]
fn demo_scene_six_sequence() {
    let mut p = readme_policy();
    assert_eq!(exec(&mut p, "vendor.testnet", 2, 1), settled(1));
    assert_eq!(
        exec(&mut p, "vendor.testnet", 4, 2),
        denied(Reason::PerPaymentCap)
    ); // a
    assert_eq!(exec(&mut p, "vendor.testnet", 3, 3), settled(3)); // b: vendor 5 of 6
    assert_eq!(
        exec(&mut p, "vendor.testnet", 3, 4),
        denied(Reason::RecipientDailyCap)
    ); // c
    assert_eq!(exec(&mut p, "vendor2.testnet", 2, 5), settled(5)); // d: agent 7
    assert_eq!(exec(&mut p, "vendor2.testnet", 2, 6), settled(6)); // e: agent 9
    assert_eq!(
        exec(&mut p, "vendor3.testnet", 2, 7),
        denied(Reason::MandateDailyCap)
    ); // f

    // g: removing and re-adding keeps today's usage.
    as_owner(T0);
    p.remove_recipient("1".into(), acc("vendor.testnet"));
    p.approve_recipient(
        "1".into(),
        acc("vendor.testnet"),
        U128(3 * NEAR),
        U128(6 * NEAR),
        None,
    );
    let usage = p.get_usage("1".into(), Some(acc("vendor.testnet")));
    assert_eq!(usage.recipient_used_today, Some(U128(5 * NEAR)));
    assert_eq!(usage.mandate_used_today, U128(9 * NEAR));
    // 5 + 2 > 6: the preserved usage blocks it. Without it, 2 would fit vendor's caps.
    assert_eq!(
        exec(&mut p, "vendor.testnet", 2, 8),
        denied(Reason::RecipientDailyCap)
    );
    assert_eq!(exec(&mut p, "vendor.testnet", 1, 9), settled(9)); // agent at 10 of 10
    assert_eq!(
        exec(&mut p, "vendor3.testnet", 1, 10),
        denied(Reason::MandateDailyCap)
    );
}

#[test]
fn untrusted_caller_is_rejected() {
    let mut p = readme_policy();
    set_env(acc("mallory.testnet"), 0, T0, 100);
    let ctx = ExecContext {
        path: vec![node("1", 10)],
        executor: acc("runner.testnet"),
        action: Action::TransferNear {
            recipient: acc("vendor.testnet"),
            amount: U128(NEAR),
        },
        request_id: rid(1),
        expected_revision: None,
    };
    match p.on_execute(ctx) {
        PromiseOrValue::Value(outcome) => assert_eq!(outcome, denied(Reason::UntrustedCaller)),
        PromiseOrValue::Promise(_) => panic!("must not dispatch"),
    }
    assert_eq!(p.get_policy().account_used_today, U128(0));
}

#[test]
fn invalid_request_ids_are_rejected() {
    let mut p = readme_policy();
    set_env(registry(), 0, T0, 100);
    let ctx = ExecContext {
        path: vec![node("1", 10)],
        executor: acc("runner.testnet"),
        action: Action::TransferNear {
            recipient: acc("vendor.testnet"),
            amount: U128(NEAR),
        },
        request_id: "not-hex".into(),
        expected_revision: None,
    };
    assert!(matches!(
        p.on_execute(ctx),
        PromiseOrValue::Value(Outcome::Denied {
            reason: Reason::InvalidRequest,
            ..
        })
    ));
}

#[test]
fn duplicate_request_ids_do_not_pay_twice() {
    let mut p = readme_policy();
    assert_eq!(exec(&mut p, "vendor.testnet", 1, 1), settled(1));
    assert_eq!(
        exec(&mut p, "vendor.testnet", 1, 1),
        denied(Reason::DuplicateRequest)
    );
    assert_eq!(p.get_usage("1".into(), None).mandate_used_today, U128(NEAR));
}

#[test]
fn settle_is_idempotent() {
    let mut p = readme_policy();
    let run = Run {
        settle: None,
        ..Run::default()
    };
    exec_with(&mut p, run, "vendor.testnet", 2, 1);
    let key = request_key("1", &rid(1));
    assert_eq!(p.settle(&key, true), settled(1));
    assert_eq!(p.settle(&key, false), settled(1));
    assert_eq!(p.get_policy().reserved_total, U128(0));
    assert_eq!(
        p.get_usage("1".into(), None).mandate_used_today,
        U128(2 * NEAR)
    );
}

#[test]
fn failed_transfer_releases_reservation() {
    let mut p = readme_policy();
    let run = Run {
        settle: Some(false),
        ..Run::default()
    };
    assert_eq!(
        exec_with(&mut p, run, "vendor.testnet", 3, 1),
        Outcome::Failed { request_id: rid(1) }
    );
    let usage = p.get_usage("1".into(), Some(acc("vendor.testnet")));
    assert_eq!(usage.mandate_used_today, U128(0));
    assert_eq!(usage.recipient_used_today, Some(U128(0)));
    assert_eq!(usage.account_used_today, U128(0));
    assert_eq!(p.get_policy().reserved_total, U128(0));
    assert_eq!(
        p.get_request("1".into(), rid(1)).unwrap().status,
        RequestStatus::Failed
    );
}

#[test]
fn pending_reservations_count_against_caps() {
    let mut p = readme_policy();
    let pending = || Run {
        settle: None,
        ..Run::default()
    };
    exec_with(&mut p, pending(), "vendor.testnet", 3, 1);
    exec_with(&mut p, pending(), "vendor.testnet", 3, 2);
    assert_eq!(
        exec_with(&mut p, pending(), "vendor.testnet", 1, 3),
        denied(Reason::RecipientDailyCap)
    );
    assert_eq!(p.get_policy().reserved_total, U128(6 * NEAR));
}

#[test]
fn stale_generation_voids_the_mandate() {
    let mut p = readme_policy();
    let run = Run {
        path: vec![node("1", 11)],
        ..Run::default()
    };
    assert_eq!(
        exec_with(&mut p, run, "vendor.testnet", 1, 1),
        denied(Reason::MandateStale)
    );
}

#[test]
fn no_mandate_on_the_path() {
    let mut p = readme_policy();
    let run = Run {
        path: vec![node("7", 1)],
        ..Run::default()
    };
    assert_eq!(
        exec_with(&mut p, run, "vendor.testnet", 1, 1),
        denied(Reason::NoMandate)
    );
}

#[test]
fn pause_and_resume() {
    let mut p = readme_policy();
    as_owner(T0);
    p.pause();
    assert_eq!(
        exec(&mut p, "vendor.testnet", 1, 1),
        denied(Reason::PaymentsPaused)
    );
    as_owner(T0);
    p.resume();
    assert_eq!(exec(&mut p, "vendor.testnet", 1, 2), settled(2));
}

#[test]
fn revoked_and_expired_mandates() {
    let mut p = readme_policy();
    as_owner(T0);
    p.revoke_mandate("1".into());
    assert_eq!(
        exec(&mut p, "vendor.testnet", 1, 1),
        denied(Reason::MandateRevoked)
    );

    as_owner(T0);
    p.set_mandate(
        "1".into(),
        vec![node("1", 10)],
        U128(10 * NEAR),
        Some(T0 + 10),
        false,
        vec![rule("vendor.testnet", 3, 6)],
        None,
    );
    let later = Run {
        now: T0 + 10,
        ..Run::default()
    };
    assert_eq!(
        exec_with(&mut p, later, "vendor.testnet", 1, 2),
        denied(Reason::MandateExpired)
    );
}

#[test]
fn recipient_rule_expiry() {
    let mut p = readme_policy();
    as_owner(T0);
    p.approve_recipient(
        "1".into(),
        acc("temp.testnet"),
        U128(NEAR),
        U128(NEAR),
        Some(T0 + 5),
    );
    assert_eq!(exec(&mut p, "temp.testnet", 1, 1), settled(1));
    let later = Run {
        now: T0 + 5,
        ..Run::default()
    };
    assert_eq!(
        exec_with(&mut p, later, "temp.testnet", 1, 2),
        denied(Reason::RecipientRuleExpired)
    );
}

#[test]
#[should_panic(expected = "A fixed mandate cannot be edited")]
fn fixed_mandate_rejects_edits() {
    let mut p = new_policy();
    as_owner(T0);
    p.set_mandate(
        "1".into(),
        vec![node("1", 10)],
        U128(10 * NEAR),
        None,
        true,
        vec![rule("vendor.testnet", 3, 6)],
        None,
    );
    p.approve_recipient(
        "1".into(),
        acc("vendor2.testnet"),
        U128(NEAR),
        U128(NEAR),
        None,
    );
}

#[test]
fn fixed_mandate_can_be_revoked_and_replaced() {
    let mut p = new_policy();
    as_owner(T0);
    p.set_mandate(
        "1".into(),
        vec![node("1", 10)],
        U128(10 * NEAR),
        None,
        true,
        vec![rule("vendor.testnet", 3, 6)],
        None,
    );
    p.revoke_mandate("1".into());
    p.set_mandate(
        "1".into(),
        vec![node("1", 10)],
        U128(5 * NEAR),
        None,
        true,
        vec![rule("vendor.testnet", 1, 2)],
        None,
    );
    assert_eq!(
        exec(&mut p, "vendor.testnet", 2, 1),
        denied(Reason::PerPaymentCap)
    );
}

#[test]
#[should_panic(expected = "The payer cannot approve itself")]
fn payer_cannot_be_a_recipient() {
    let mut p = readme_policy();
    as_owner(T0);
    p.approve_recipient("1".into(), alice(), U128(NEAR), U128(NEAR), None);
}

#[test]
#[should_panic(expected = "Per-payment cap cannot exceed the daily cap")]
fn per_payment_above_daily_is_rejected() {
    let mut p = readme_policy();
    as_owner(T0);
    p.approve_recipient(
        "1".into(),
        acc("x.testnet"),
        U128(2 * NEAR),
        U128(NEAR),
        None,
    );
}

#[test]
fn revision_check() {
    let mut p = readme_policy();
    let revision = p.get_revision();
    let stale = Run {
        expected_revision: Some(revision - 1),
        ..Run::default()
    };
    assert_eq!(
        exec_with(&mut p, stale, "vendor.testnet", 1, 1),
        denied(Reason::RevisionMismatch)
    );
    let current = Run {
        expected_revision: Some(revision),
        ..Run::default()
    };
    assert_eq!(
        exec_with(&mut p, current, "vendor.testnet", 1, 2),
        settled(2)
    );
}

#[test]
fn insufficient_balance_keeps_the_safety_buffer() {
    let mut p = readme_policy();
    // 3 NEAR balance minus the 0.5 NEAR buffer and storage leaves less than 3.
    let poor = Run {
        balance: 3,
        ..Run::default()
    };
    assert_eq!(
        exec_with(&mut p, poor, "vendor.testnet", 3, 1),
        denied(Reason::InsufficientBalance)
    );
    let poor = Run {
        balance: 3,
        ..Run::default()
    };
    assert_eq!(exec_with(&mut p, poor, "vendor.testnet", 2, 2), settled(2));
}

#[test]
fn account_daily_cap_spans_agents() {
    let mut p = readme_policy();
    as_owner(T0);
    p.set_mandate(
        "2".into(),
        vec![node("2", 20)],
        U128(10 * NEAR),
        None,
        false,
        vec![rule("vendor.testnet", 3, 6)],
        None,
    );
    p.set_account_daily_cap(Some(U128(4 * NEAR)));
    assert_eq!(exec(&mut p, "vendor.testnet", 3, 1), settled(1));
    let other = Run {
        path: vec![node("2", 20)],
        ..Run::default()
    };
    assert_eq!(
        exec_with(&mut p, other, "vendor.testnet", 2, 2),
        denied(Reason::AccountDailyCap)
    );
}

#[test]
fn new_day_resets_usage() {
    let mut p = readme_policy();
    assert_eq!(exec(&mut p, "vendor.testnet", 3, 1), settled(1));
    assert_eq!(exec(&mut p, "vendor.testnet", 3, 2), settled(2));
    assert_eq!(
        exec(&mut p, "vendor.testnet", 3, 3),
        denied(Reason::RecipientDailyCap)
    );
    let tomorrow = Run {
        now: T0 + DAY_NS,
        ..Run::default()
    };
    assert_eq!(
        exec_with(&mut p, tomorrow, "vendor.testnet", 3, 4),
        settled(4)
    );
}

#[test]
fn failure_settled_the_next_day_does_not_touch_new_usage() {
    let mut p = readme_policy();
    exec_with(
        &mut p,
        Run {
            settle: None,
            ..Run::default()
        },
        "vendor.testnet",
        3,
        1,
    );
    let tomorrow = Run {
        now: T0 + DAY_NS,
        ..Run::default()
    };
    assert_eq!(
        exec_with(&mut p, tomorrow, "vendor.testnet", 2, 2),
        settled(2)
    );
    set_env(alice(), 0, T0 + DAY_NS, 100);
    p.settle(&request_key("1", &rid(1)), false);
    assert_eq!(
        p.get_usage("1".into(), None).mandate_used_today,
        U128(2 * NEAR)
    );
    assert_eq!(p.get_policy().reserved_total, U128(0));
}

#[test]
fn branch_pool_is_shared_by_leaves() {
    let mut p = new_policy();
    as_owner(T0);
    p.set_mandate(
        "1".into(),
        vec![node("1", 1)],
        U128(5 * NEAR),
        None,
        false,
        vec![rule("vendor.testnet", 3, 6), rule("vendor2.testnet", 2, 4)],
        None,
    );
    let bot1 = || Run {
        path: vec![node("1", 1), node("2", 2)],
        ..Run::default()
    };
    let bot2 = || Run {
        path: vec![node("1", 1), node("3", 3)],
        ..Run::default()
    };
    assert_eq!(
        exec_with(&mut p, bot1(), "vendor.testnet", 3, 1),
        settled(1)
    );
    assert_eq!(
        exec_with(&mut p, bot2(), "vendor2.testnet", 2, 2),
        settled(2)
    );
    assert_eq!(
        exec_with(&mut p, bot1(), "vendor.testnet", 1, 3),
        denied(Reason::MandateDailyCap)
    );
    // The same request ID from two different leaves is two different requests.
    as_owner(T0);
    p.set_mandate(
        "1".into(),
        vec![node("1", 1)],
        U128(20 * NEAR),
        None,
        false,
        vec![rule("vendor.testnet", 3, 9)],
        None,
    );
    assert_eq!(
        exec_with(&mut p, bot2(), "vendor.testnet", 1, 1),
        settled(1)
    );
}

#[test]
fn leaf_mandate_and_branch_mandate_both_apply() {
    let mut p = new_policy();
    as_owner(T0);
    p.set_mandate(
        "1".into(),
        vec![node("1", 1)],
        U128(10 * NEAR),
        None,
        false,
        vec![rule("vendor.testnet", 3, 9)],
        None,
    );
    p.set_mandate(
        "2".into(),
        vec![node("1", 1), node("2", 2)],
        U128(2 * NEAR),
        None,
        false,
        vec![rule("vendor.testnet", 1, 2)],
        None,
    );
    let leaf = || Run {
        path: vec![node("1", 1), node("2", 2)],
        ..Run::default()
    };
    assert_eq!(
        exec_with(&mut p, leaf(), "vendor.testnet", 2, 1),
        denied(Reason::PerPaymentCap)
    );
    assert_eq!(
        exec_with(&mut p, leaf(), "vendor.testnet", 1, 2),
        settled(2)
    );
    assert_eq!(
        exec_with(&mut p, leaf(), "vendor.testnet", 1, 3),
        settled(3)
    );
    assert_eq!(
        exec_with(&mut p, leaf(), "vendor.testnet", 1, 4),
        denied(Reason::RecipientDailyCap)
    );
    assert_eq!(
        p.get_usage("1".into(), None).mandate_used_today,
        U128(2 * NEAR)
    );
    assert_eq!(
        p.get_usage("2".into(), None).mandate_used_today,
        U128(2 * NEAR)
    );
}

#[test]
fn transferring_an_ancestor_voids_branch_and_leaf_mandates() {
    let mut p = new_policy();
    as_owner(T0);
    p.set_mandate(
        "2".into(),
        vec![node("1", 1), node("2", 2)],
        U128(5 * NEAR),
        None,
        false,
        vec![rule("vendor.testnet", 3, 6)],
        None,
    );
    let moved = Run {
        path: vec![node("1", 9), node("2", 2)],
        ..Run::default()
    };
    assert_eq!(
        exec_with(&mut p, moved, "vendor.testnet", 1, 1),
        denied(Reason::MandateStale)
    );
}

#[test]
fn requests_are_pruned_after_retention() {
    let mut p = readme_policy();
    assert_eq!(exec(&mut p, "vendor.testnet", 1, 1), settled(1));
    assert!(p.get_request("1".into(), rid(1)).is_some());
    let later = Run {
        now: T0 + REQUEST_RETENTION_NS + 1,
        ..Run::default()
    };
    assert_eq!(exec_with(&mut p, later, "vendor.testnet", 1, 2), settled(2));
    assert!(p.get_request("1".into(), rid(1)).is_none());
    assert!(p.get_request("1".into(), rid(2)).is_some());
}

#[test]
fn pending_requests_are_never_pruned() {
    let mut p = readme_policy();
    exec_with(
        &mut p,
        Run {
            settle: None,
            ..Run::default()
        },
        "vendor.testnet",
        1,
        1,
    );
    let later = Run {
        now: T0 + 3 * REQUEST_RETENTION_NS,
        ..Run::default()
    };
    exec_with(&mut p, later, "vendor.testnet", 1, 2);
    assert_eq!(
        p.get_request("1".into(), rid(1)).unwrap().status,
        RequestStatus::Pending
    );
}

#[test]
fn activity_ring_buffer_is_bounded_and_newest_first() {
    let mut p = new_policy();
    as_owner(T0);
    p.set_mandate(
        "1".into(),
        vec![node("1", 10)],
        U128(1000 * NEAR),
        None,
        false,
        vec![rule("vendor.testnet", 1, 1000)],
        None,
    );
    for n in 0..(ACTIVITY_SIZE + 6) {
        exec(&mut p, "vendor.testnet", 1, n);
    }
    exec(&mut p, "stranger.testnet", 1, 999);
    let all = p.get_activity(None, Some(1000));
    assert_eq!(all.len() as u64, ACTIVITY_SIZE);
    assert_eq!(all[0].outcome, "denied");
    assert_eq!(all[0].reason, Some(Reason::RecipientNotApproved));
    assert!(all.windows(2).all(|w| w[0].seq > w[1].seq));
    let page = p.get_activity(Some(all[9].seq), Some(5));
    assert_eq!(page.len(), 5);
    assert_eq!(page[0].seq, all[10].seq);
}

#[test]
fn preview_matches_execution_without_changing_state() {
    let mut p = readme_policy();
    set_env(acc("anyone.testnet"), 0, T0, 100);
    let ctx = |amount: u128, n: u64| ExecContext {
        path: vec![node("1", 10)],
        executor: acc("runner.testnet"),
        action: Action::TransferNear {
            recipient: acc("vendor.testnet"),
            amount: U128(amount * NEAR),
        },
        request_id: rid(n),
        expected_revision: None,
    };
    let ok = p.preview(ctx(2, 1));
    assert!(ok.allowed);
    assert_eq!(ok.mandates, vec!["1".to_string()]);
    assert_eq!(p.preview(ctx(4, 1)).reason, Some(Reason::PerPaymentCap));
    assert_eq!(p.get_usage("1".into(), None).mandate_used_today, U128(0));
    assert_eq!(exec(&mut p, "vendor.testnet", 2, 1), settled(1));
    set_env(acc("anyone.testnet"), 0, T0, 100);
    assert_eq!(p.preview(ctx(1, 1)).reason, Some(Reason::DuplicateRequest));
}

#[test]
fn on_settle_reads_the_promise_result() {
    let mut p = readme_policy();
    exec_with(
        &mut p,
        Run {
            settle: None,
            ..Run::default()
        },
        "vendor.testnet",
        2,
        1,
    );
    let mut b = VMContextBuilder::new();
    b.current_account_id(alice())
        .predecessor_account_id(alice())
        .block_timestamp(T0);
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed]
    );
    assert_eq!(
        p.on_settle(request_key("1", &rid(1))),
        Outcome::Failed { request_id: rid(1) }
    );
}

// ---------------------------------------------------------------- connections (R2)

use near_sdk::{CurveType, Gas};

fn agent_key(byte: u8) -> PublicKey {
    PublicKey::from_parts(CurveType::ED25519, vec![byte; 32]).unwrap()
}

/// A transaction signed on alice's own account with `key`, calling alice.
fn as_key(key: &PublicKey, now: u64, gas_tgas: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(alice())
        .signer_account_id(alice())
        .predecessor_account_id(alice())
        .signer_account_pk(key.clone())
        .prepaid_gas(Gas::from_tgas(gas_tgas))
        .block_timestamp(now)
        .storage_usage(10_000)
        .account_balance(NearToken::from_yoctonear(100 * NEAR));
    testing_env!(b.build());
}

/// A callback receipt on alice with one promise result.
fn as_callback(now: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(alice())
        .predecessor_account_id(alice())
        .block_timestamp(now)
        .storage_usage(10_000)
        .account_balance(NearToken::from_yoctonear(100 * NEAR));
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(vec![])]
    );
}

fn pay(recipient: &str, amount_near: u128) -> Action {
    Action::TransferNear {
        recipient: acc(recipient),
        amount: U128(amount_near * NEAR),
    }
}

fn connected_policy() -> (AccountPolicy, PublicKey) {
    let mut p = readme_policy();
    let key = agent_key(7);
    as_owner(T0);
    p.connect_agent_key(
        "1".into(),
        key.clone(),
        "claude-desktop".into(),
        "Claude on laptop".into(),
    );
    (p, key)
}

fn allowed(path: Vec<PathNode>) -> Result<Authorization, PromiseError> {
    Ok(Authorization::Allowed { path })
}

/// Runs the registry's answer through `on_authorized`, then settles a dispatched transfer.
fn through_connection(
    p: &mut AccountPolicy,
    key: &PublicKey,
    auth: Result<Authorization, PromiseError>,
    recipient: &str,
    amount: u128,
    request: u64,
) -> Outcome {
    as_callback(T0);
    match p.on_authorized(
        String::from(key),
        pay(recipient, amount),
        rid(request),
        Some("Claude Desktop".into()),
        auth,
    ) {
        PromiseOrValue::Value(outcome) => outcome,
        PromiseOrValue::Promise(_) => p.settle(&request_key("1", &rid(request)), true),
    }
}

#[test]
fn connections_are_recorded_and_listed() {
    let (mut p, key) = connected_policy();
    let all = p.get_connections(None);
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].agent_id, "1");
    assert_eq!(all[0].platform, "claude-desktop");
    assert_eq!(p.get_connections(Some("2".into())).len(), 0);
    assert_eq!(
        p.get_connection(key.clone()).unwrap().label,
        "Claude on laptop"
    );
    assert_eq!(p.get_policy().connections, 1);
    as_owner(T0);
    p.disconnect_agent_key(key.clone());
    assert!(p.get_connection(key).is_none());
    assert_eq!(p.get_policy().connections, 0);
}

#[test]
#[should_panic(expected = "This key is already connected")]
fn a_key_connects_once() {
    let (mut p, key) = connected_policy();
    as_owner(T0);
    p.connect_agent_key("1".into(), key, "n8n".into(), "again".into());
}

#[test]
#[should_panic(expected = "Only the account itself can change its policy")]
fn only_the_owner_connects_keys() {
    let mut p = readme_policy();
    set_env(registry(), 1, T0, 100);
    p.connect_agent_key("1".into(), agent_key(1), "n8n".into(), "x".into());
}

#[test]
#[should_panic(expected = "Too many connections for this agent")]
fn connections_per_agent_are_limited() {
    let mut p = readme_policy();
    as_owner(T0);
    for i in 0..=MAX_CONNECTIONS_PER_AGENT as u8 {
        p.connect_agent_key(
            "1".into(),
            agent_key(i + 1),
            "custom".into(),
            format!("key {i}"),
        );
    }
}

#[test]
fn unknown_keys_and_other_signers_are_refused() {
    let (mut p, _) = connected_policy();
    as_key(&agent_key(99), T0, 120);
    assert!(matches!(
        p.agent_execute(pay("vendor.testnet", 1), rid(1), None),
        PromiseOrValue::Value(Outcome::Denied {
            reason: Reason::UnknownConnection,
            ..
        })
    ));
    // A self-call started by someone else's transaction carries a stranger's key.
    let mut b = VMContextBuilder::new();
    b.current_account_id(alice())
        .predecessor_account_id(alice())
        .signer_account_id(acc("relayer.testnet"))
        .signer_account_pk(agent_key(7))
        .prepaid_gas(Gas::from_tgas(120));
    testing_env!(b.build());
    assert!(matches!(
        p.agent_execute(pay("vendor.testnet", 1), rid(2), None),
        PromiseOrValue::Value(Outcome::Denied {
            reason: Reason::UnknownConnection,
            ..
        })
    ));
}

#[test]
fn a_connected_key_asks_the_registry() {
    let (mut p, key) = connected_policy();
    as_key(&key, T0, 120);
    assert!(matches!(
        p.agent_execute(pay("vendor.testnet", 1), rid(1), None),
        PromiseOrValue::Promise(_)
    ));
    // Nothing is reserved until the registry answers.
    assert_eq!(p.get_policy().reserved_total, U128(0));
}

#[test]
#[should_panic(expected = "Attach at least 90 Tgas")]
fn agent_execute_needs_enough_gas() {
    let (mut p, key) = connected_policy();
    as_key(&key, T0, 30);
    let _ = p.agent_execute(pay("vendor.testnet", 1), rid(1), None);
}

#[test]
fn an_authorized_connection_pays_and_is_attributed() {
    let (mut p, key) = connected_policy();
    assert_eq!(
        through_connection(
            &mut p,
            &key,
            allowed(vec![node("1", 10)]),
            "vendor.testnet",
            2,
            1
        ),
        settled(1)
    );
    let activity = &p.get_activity(None, Some(1))[0];
    assert_eq!(activity.outcome, "settled");
    assert_eq!(
        activity.via,
        Some(Via::Connection {
            public_key: String::from(&key),
            label: "Claude on laptop".into()
        })
    );
    assert_eq!(activity.client.as_deref(), Some("Claude Desktop"));
    let connection = p.get_connection(key).unwrap();
    assert_eq!(connection.uses, 1);
    assert!(connection.last_used.is_some());
}

#[test]
fn the_registry_refusal_is_recorded() {
    let (mut p, key) = connected_policy();
    let refusal = Ok(Authorization::Denied {
        reason: Reason::BranchPaused,
        detail: None,
    });
    assert_eq!(
        through_connection(&mut p, &key, refusal, "vendor.testnet", 1, 1),
        denied(Reason::BranchPaused)
    );
    assert_eq!(
        p.get_activity(None, Some(1))[0].reason,
        Some(Reason::BranchPaused)
    );
    assert_eq!(p.get_policy().reserved_total, U128(0));
}

#[test]
fn a_failed_registry_call_fails_closed() {
    let (mut p, key) = connected_policy();
    assert_eq!(
        through_connection(
            &mut p,
            &key,
            Err(PromiseError::Failed),
            "vendor.testnet",
            1,
            1
        ),
        denied(Reason::AuthorizationFailed)
    );
}

#[test]
fn a_path_for_another_agent_is_refused() {
    let (mut p, key) = connected_policy();
    assert_eq!(
        through_connection(
            &mut p,
            &key,
            allowed(vec![node("2", 3)]),
            "vendor.testnet",
            1,
            1
        ),
        denied(Reason::InvalidRequest)
    );
}

#[test]
fn a_key_disconnected_meanwhile_is_refused() {
    let (mut p, key) = connected_policy();
    as_owner(T0);
    p.disconnect_agent_key(key.clone());
    assert_eq!(
        through_connection(
            &mut p,
            &key,
            allowed(vec![node("1", 10)]),
            "vendor.testnet",
            1,
            1
        ),
        denied(Reason::UnknownConnection)
    );
}

#[test]
fn connection_rules_are_the_same_rules() {
    let (mut p, key) = connected_policy();
    assert_eq!(
        through_connection(
            &mut p,
            &key,
            allowed(vec![node("1", 10)]),
            "attacker.testnet",
            1,
            1
        ),
        denied(Reason::RecipientNotApproved)
    );
    assert_eq!(
        through_connection(
            &mut p,
            &key,
            allowed(vec![node("1", 10)]),
            "vendor.testnet",
            4,
            2
        ),
        denied(Reason::PerPaymentCap)
    );
    assert_eq!(
        through_connection(
            &mut p,
            &key,
            allowed(vec![node("1", 11)]),
            "vendor.testnet",
            1,
            3
        ),
        denied(Reason::MandateStale)
    );
}

#[test]
fn the_same_request_id_pays_once_across_the_async_hop() {
    let (mut p, key) = connected_policy();
    as_callback(T0);
    assert!(matches!(
        p.on_authorized(
            String::from(&key),
            pay("vendor.testnet", 1),
            rid(1),
            None,
            allowed(vec![node("1", 10)])
        ),
        PromiseOrValue::Promise(_)
    ));
    as_callback(T0);
    assert!(matches!(
        p.on_authorized(
            String::from(&key),
            pay("vendor.testnet", 1),
            rid(1),
            None,
            allowed(vec![node("1", 10)])
        ),
        PromiseOrValue::Value(Outcome::Denied {
            reason: Reason::DuplicateRequest,
            ..
        })
    ));
    assert_eq!(p.get_policy().reserved_total, U128(NEAR));
}

#[test]
#[should_panic(expected = "Expected one promise result")]
fn on_settle_needs_exactly_one_result() {
    let mut p = readme_policy();
    exec_with(
        &mut p,
        Run {
            settle: None,
            ..Run::default()
        },
        "vendor.testnet",
        2,
        1,
    );
    set_env(alice(), 0, T0, 100);
    p.on_settle(request_key("1", &rid(1)));
}

// ---------------------------------------------------------------- "ask me first" (R5)

/// vendor and vendor2 at 5 per payment and 9 per day, with confirmation above 4 NEAR.
fn confirming_policy() -> AccountPolicy {
    let mut p = new_policy();
    as_owner(T0);
    p.set_mandate(
        "1".into(),
        vec![node("1", 10)],
        U128(20 * NEAR),
        None,
        false,
        vec![rule("vendor.testnet", 5, 9), rule("vendor2.testnet", 5, 9)],
        Some(U128(4 * NEAR)),
    );
    p
}

fn awaiting(p: &mut AccountPolicy, recipient: &str, amount: u128, request: u64) -> u64 {
    match exec(p, recipient, amount, request) {
        Outcome::AwaitingConfirmation { expires_at, .. } => expires_at,
        other => panic!("expected awaiting confirmation, got {other:?}"),
    }
}

#[test]
fn payments_above_the_threshold_wait_and_reserve() {
    let mut p = confirming_policy();
    assert_eq!(exec(&mut p, "vendor.testnet", 3, 1), settled(1));
    let expires_at = awaiting(&mut p, "vendor.testnet", 5, 2);
    assert_eq!(expires_at, T0 + CONFIRM_WINDOW_NS);
    let pending = p.get_pending();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].amount, U128(5 * NEAR));
    assert_eq!(p.get_policy().reserved_total, U128(5 * NEAR));
    assert_eq!(p.get_policy().pending, 1);
    // Reserved amounts count against the caps: 3 + 5 + 2 > 9.
    assert_eq!(
        exec(&mut p, "vendor.testnet", 2, 3),
        denied(Reason::RecipientDailyCap)
    );
    assert_eq!(p.get_activity(None, Some(5))[1].outcome, "awaiting");
}

#[test]
fn caps_deny_before_anything_waits() {
    let mut p = confirming_policy();
    assert_eq!(
        exec(&mut p, "vendor.testnet", 6, 1),
        denied(Reason::PerPaymentCap)
    );
    assert!(p.get_pending().is_empty());
}

#[test]
fn a_recipient_threshold_applies_to_that_recipient() {
    let mut p = new_policy();
    as_owner(T0);
    let mut strict = rule("vendor.testnet", 5, 9);
    strict.confirm_above = Some(U128(NEAR));
    p.set_mandate(
        "1".into(),
        vec![node("1", 10)],
        U128(20 * NEAR),
        None,
        false,
        vec![strict, rule("vendor2.testnet", 5, 9)],
        None,
    );
    awaiting(&mut p, "vendor.testnet", 2, 1);
    assert_eq!(exec(&mut p, "vendor2.testnet", 2, 2), settled(2));
}

#[test]
fn the_threshold_can_be_changed_later() {
    let mut p = readme_policy();
    as_owner(T0);
    p.set_confirm_above("1".into(), None, Some(U128(NEAR)));
    awaiting(&mut p, "vendor.testnet", 2, 1);
    as_owner(T0);
    p.set_confirm_above("1".into(), None, None);
    assert_eq!(exec(&mut p, "vendor.testnet", 2, 2), settled(2));
}

#[test]
fn confirming_sends_the_payment() {
    let mut p = confirming_policy();
    awaiting(&mut p, "vendor.testnet", 5, 1);
    as_owner(T0 + 10);
    assert!(matches!(
        p.confirm("1".into(), rid(1), None),
        PromiseOrValue::Promise(_)
    ));
    as_callback(T0 + 20);
    let key = request_key("1", &rid(1));
    assert!(matches!(
        p.on_confirm_authorized(key.clone(), allowed(vec![node("1", 10)])),
        PromiseOrValue::Promise(_)
    ));
    assert!(p.get_pending().is_empty());
    assert_eq!(
        p.get_request("1".into(), rid(1)).unwrap().status,
        RequestStatus::Pending
    );
    assert_eq!(p.settle(&key, true), settled(1));
    assert_eq!(p.get_policy().reserved_total, U128(0));
    assert_eq!(
        p.get_usage("1".into(), None).mandate_used_today,
        U128(5 * NEAR)
    );
}

#[test]
fn a_stale_approval_at_confirmation_releases_the_reservation() {
    let mut p = confirming_policy();
    awaiting(&mut p, "vendor.testnet", 5, 1);
    as_callback(T0 + 20);
    let outcome = p.on_confirm_authorized(request_key("1", &rid(1)), allowed(vec![node("1", 11)]));
    assert!(matches!(
        outcome,
        PromiseOrValue::Value(Outcome::Denied {
            reason: Reason::MandateStale,
            ..
        })
    ));
    assert_eq!(p.get_policy().reserved_total, U128(0));
    assert_eq!(p.get_usage("1".into(), None).mandate_used_today, U128(0));
    assert_eq!(
        p.get_request("1".into(), rid(1)).unwrap().status,
        RequestStatus::Declined
    );
}

#[test]
#[should_panic(expected = "Payments are paused")]
fn confirming_while_paused_is_refused() {
    let mut p = confirming_policy();
    awaiting(&mut p, "vendor.testnet", 5, 1);
    as_owner(T0);
    p.pause();
    let _ = p.confirm("1".into(), rid(1), None);
}

#[test]
fn declining_releases_and_keeps_the_id_used() {
    let mut p = confirming_policy();
    awaiting(&mut p, "vendor.testnet", 5, 1);
    as_owner(T0);
    assert_eq!(
        p.decline("1".into(), rid(1)),
        denied(Reason::ConfirmationDeclined)
    );
    assert_eq!(p.get_policy().reserved_total, U128(0));
    assert!(p.get_pending().is_empty());
    assert_eq!(
        exec(&mut p, "vendor.testnet", 1, 1),
        denied(Reason::DuplicateRequest)
    );
    assert_eq!(p.get_activity(None, Some(1))[0].outcome, "declined");
}

#[test]
#[should_panic(expected = "This payment has not expired yet")]
fn expiry_only_after_the_deadline() {
    let mut p = confirming_policy();
    awaiting(&mut p, "vendor.testnet", 5, 1);
    set_env(acc("anyone.testnet"), 0, T0 + 5, 100);
    p.expire("1".into(), rid(1));
}

#[test]
fn anyone_can_expire_after_the_deadline() {
    let mut p = confirming_policy();
    let expires_at = awaiting(&mut p, "vendor.testnet", 5, 1);
    set_env(acc("anyone.testnet"), 0, expires_at, 100);
    assert_eq!(
        p.expire("1".into(), rid(1)),
        denied(Reason::ConfirmationExpired)
    );
    assert_eq!(p.get_policy().reserved_total, U128(0));
    assert_eq!(
        p.get_request("1".into(), rid(1)).unwrap().status,
        RequestStatus::Expired
    );
}

#[test]
fn overdue_confirmations_expire_lazily() {
    let mut p = confirming_policy();
    let expires_at = awaiting(&mut p, "vendor.testnet", 5, 1);
    let later = Run {
        now: expires_at + 1,
        ..Run::default()
    };
    assert_eq!(
        exec_with(&mut p, later, "vendor2.testnet", 1, 2),
        settled(2)
    );
    assert!(p.get_pending().is_empty());
    assert_eq!(p.get_policy().reserved_total, U128(0));
}

#[test]
fn waiting_payments_per_agent_are_limited() {
    let mut p = new_policy();
    as_owner(T0);
    p.set_mandate(
        "1".into(),
        vec![node("1", 10)],
        U128(1000 * NEAR),
        None,
        false,
        vec![rule("vendor.testnet", 10, 1000)],
        Some(U128(NEAR)),
    );
    for i in 0..MAX_PENDING_PER_AGENT as u64 {
        awaiting(&mut p, "vendor.testnet", 2, i);
    }
    assert_eq!(
        exec(&mut p, "vendor.testnet", 2, 99),
        denied(Reason::TooManyPending)
    );
}

#[test]
fn pruning_continues_while_payments_wait() {
    let mut p = confirming_policy();
    assert_eq!(exec(&mut p, "vendor.testnet", 1, 1), settled(1));
    awaiting(&mut p, "vendor.testnet", 5, 2);
    let later = Run {
        now: T0 + REQUEST_RETENTION_NS + 1,
        ..Run::default()
    };
    // The waiting payment expired lazily and the old settled request was pruned.
    assert_eq!(
        exec_with(&mut p, later, "vendor2.testnet", 1, 3),
        settled(3)
    );
    assert!(p.get_request("1".into(), rid(1)).is_none());
}

#[test]
fn preview_reports_when_confirmation_is_needed() {
    let p = confirming_policy();
    set_env(acc("anyone.testnet"), 0, T0, 100);
    let ctx = ExecContext {
        path: vec![node("1", 10)],
        executor: acc("runner.testnet"),
        action: pay("vendor.testnet", 5),
        request_id: rid(1),
        expected_revision: None,
    };
    let preview = p.preview(ctx);
    assert!(preview.allowed);
    assert!(preview.needs_confirmation);
}
