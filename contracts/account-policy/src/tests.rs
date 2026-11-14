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

// ---------------------------------------------------------------- blocklist and guardians (R7)

fn guardian_policy() -> (AccountPolicy, PublicKey) {
    let mut p = readme_policy();
    let key = agent_key(42);
    as_owner(T0);
    p.add_guardian_key(key.clone(), "watcher".into());
    (p, key)
}

#[test]
fn blocked_recipients_are_refused_even_when_approved() {
    let mut p = readme_policy();
    assert_eq!(exec(&mut p, "vendor.testnet", 1, 1), settled(1));
    as_owner(T0);
    p.block_recipient(acc("vendor.testnet"), Some("hijacked site".into()));
    assert_eq!(
        exec(&mut p, "vendor.testnet", 1, 2),
        denied(Reason::RecipientBlocked)
    );
    // Other approved recipients are unaffected.
    assert_eq!(exec(&mut p, "vendor2.testnet", 1, 3), settled(3));
    assert!(p.is_blocked(acc("vendor.testnet")));
    let list = p.get_blocklist();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].by, "owner");
    assert_eq!(list[0].reason.as_deref(), Some("hijacked site"));
    assert_eq!(p.get_policy().blocked, 1);
    assert_eq!(
        p.get_activity(None, Some(2))[1].reason,
        Some(Reason::RecipientBlocked)
    );
}

#[test]
fn the_blocklist_applies_to_connections_too() {
    let (mut p, key) = connected_policy();
    as_owner(T0);
    p.block_recipient(acc("vendor.testnet"), None);
    assert_eq!(
        through_connection(
            &mut p,
            &key,
            allowed(vec![node("1", 10)]),
            "vendor.testnet",
            1,
            1
        ),
        denied(Reason::RecipientBlocked)
    );
    assert_eq!(p.get_policy().reserved_total, U128(0));
}

#[test]
fn unblocking_restores_the_approval() {
    let mut p = readme_policy();
    as_owner(T0);
    p.block_recipient(acc("vendor.testnet"), None);
    assert_eq!(
        exec(&mut p, "vendor.testnet", 1, 1),
        denied(Reason::RecipientBlocked)
    );
    as_owner(T0);
    p.unblock_recipient(acc("vendor.testnet"));
    assert!(!p.is_blocked(acc("vendor.testnet")));
    assert_eq!(exec(&mut p, "vendor.testnet", 1, 2), settled(2));
}

#[test]
#[should_panic(expected = "This recipient is not blocked")]
fn unblocking_an_unknown_recipient_fails() {
    let mut p = readme_policy();
    as_owner(T0);
    p.unblock_recipient(acc("vendor.testnet"));
}

#[test]
fn a_recipient_blocked_while_waiting_is_declined_at_confirmation() {
    let mut p = confirming_policy();
    awaiting(&mut p, "vendor.testnet", 5, 1);
    as_owner(T0 + 5);
    p.block_recipient(acc("vendor.testnet"), Some("flagged".into()));
    as_callback(T0 + 20);
    let outcome = p.on_confirm_authorized(request_key("1", &rid(1)), allowed(vec![node("1", 10)]));
    assert!(matches!(
        outcome,
        PromiseOrValue::Value(Outcome::Denied {
            reason: Reason::RecipientBlocked,
            ..
        })
    ));
    assert_eq!(p.get_policy().reserved_total, U128(0));
    assert_eq!(
        p.get_request("1".into(), rid(1)).unwrap().status,
        RequestStatus::Declined
    );
}

#[test]
fn preview_reports_a_blocked_recipient() {
    let mut p = readme_policy();
    as_owner(T0);
    p.block_recipient(acc("vendor.testnet"), None);
    set_env(acc("anyone.testnet"), 0, T0, 100);
    let preview = p.preview(ExecContext {
        path: vec![node("1", 10)],
        executor: acc("runner.testnet"),
        action: pay("vendor.testnet", 1),
        request_id: rid(1),
        expected_revision: None,
    });
    assert!(!preview.allowed);
    assert_eq!(preview.reason, Some(Reason::RecipientBlocked));
}

#[test]
#[should_panic(expected = "The account cannot block itself")]
fn the_account_cannot_block_itself() {
    let mut p = readme_policy();
    as_owner(T0);
    p.block_recipient(alice(), None);
}

#[test]
#[should_panic(expected = "The blocklist is full")]
fn the_blocklist_is_bounded() {
    let mut p = readme_policy();
    as_owner(T0);
    for i in 0..=MAX_BLOCKED {
        p.block_recipient(acc(&format!("scam{i}.testnet")), None);
    }
}

#[test]
fn a_guardian_adds_blocks_without_a_deposit() {
    let (mut p, key) = guardian_policy();
    let revision = p.get_revision();
    as_key(&key, T0 + 5, 30);
    assert!(p.guardian_block(acc("vendor.testnet"), Some("fingerprint mismatch".into())));
    let entry = &p.get_blocklist()[0];
    assert_eq!(entry.by, "guardian:watcher");
    assert_eq!(entry.reason.as_deref(), Some("fingerprint mismatch"));
    let guardian = &p.get_guardians()[0];
    assert_eq!((guardian.blocks, guardian.last_used.is_some()), (1, true));
    assert_eq!(p.get_revision(), revision + 1);
    assert_eq!(p.get_policy().guardians, 1);
    // Every agent is refused from the next request, though the recipient was approved.
    assert_eq!(
        exec(&mut p, "vendor.testnet", 1, 1),
        denied(Reason::RecipientBlocked)
    );
}

#[test]
fn guardian_blocks_are_idempotent_and_never_overwrite_the_owner() {
    let (mut p, key) = guardian_policy();
    as_owner(T0);
    p.block_recipient(acc("owned.testnet"), Some("mine".into()));
    as_key(&key, T0, 30);
    assert!(!p.guardian_block(acc("owned.testnet"), Some("theirs".into())));
    assert_eq!(p.get_blocklist()[0].by, "owner");
    assert_eq!(p.get_blocklist()[0].reason.as_deref(), Some("mine"));
    assert!(p.guardian_block(acc("scam.testnet"), None));
    let revision = p.get_revision();
    assert!(!p.guardian_block(acc("scam.testnet"), None));
    assert_eq!(p.get_revision(), revision);
}

#[test]
#[should_panic(expected = "exactly 1 yoctoNEAR")]
fn a_guardian_cannot_unblock() {
    let (mut p, key) = guardian_policy();
    as_owner(T0);
    p.block_recipient(acc("scam.testnet"), None);
    // The guardian key signs a transaction on the account, but owner methods need a deposit.
    as_key(&key, T0, 30);
    p.unblock_recipient(acc("scam.testnet"));
}

#[test]
#[should_panic(expected = "exactly 1 yoctoNEAR")]
fn a_guardian_cannot_change_approvals() {
    let (mut p, key) = guardian_policy();
    as_key(&key, T0, 30);
    p.approve_recipient(
        "1".into(),
        acc("attacker.testnet"),
        U128(NEAR),
        U128(NEAR),
        None,
    );
}

#[test]
#[should_panic(expected = "This key is not a guardian")]
fn only_guardian_keys_can_call_guardian_block() {
    let (mut p, key) = connected_policy(); // a connected agent key, not a guardian
    as_key(&key, T0, 30);
    p.guardian_block(acc("scam.testnet"), None);
}

#[test]
#[should_panic(expected = "Only a guardian key on this account can call this")]
fn a_relayed_guardian_call_is_refused() {
    let (mut p, key) = guardian_policy();
    let mut b = VMContextBuilder::new();
    b.current_account_id(alice())
        .predecessor_account_id(alice())
        .signer_account_id(acc("relayer.testnet"))
        .signer_account_pk(key);
    testing_env!(b.build());
    p.guardian_block(acc("scam.testnet"), None);
}

#[test]
#[should_panic(expected = "A guardian cannot attach a deposit")]
fn a_guardian_cannot_attach_a_deposit() {
    let (mut p, key) = guardian_policy();
    let mut b = VMContextBuilder::new();
    b.current_account_id(alice())
        .predecessor_account_id(alice())
        .signer_account_id(alice())
        .signer_account_pk(key)
        .attached_deposit(NearToken::from_yoctonear(1));
    testing_env!(b.build());
    p.guardian_block(acc("scam.testnet"), None);
}

#[test]
#[should_panic(expected = "Guardians have reached their limit")]
fn guardians_cannot_fill_the_blocklist() {
    let (mut p, key) = guardian_policy();
    as_key(&key, T0, 30);
    for i in 0..=MAX_GUARDIAN_BLOCKS {
        p.guardian_block(acc(&format!("scam{i}.testnet")), None);
    }
}

#[test]
fn the_owner_can_still_block_when_guardians_are_at_their_limit() {
    let (mut p, key) = guardian_policy();
    as_key(&key, T0, 30);
    for i in 0..MAX_GUARDIAN_BLOCKS {
        assert!(p.guardian_block(acc(&format!("scam{i}.testnet")), None));
    }
    as_owner(T0);
    p.block_recipient(acc("another.testnet"), None);
    assert_eq!(p.get_policy().blocked as usize, MAX_GUARDIAN_BLOCKS + 1);
}

#[test]
#[should_panic(expected = "This key is not a guardian")]
fn a_removed_guardian_stops_working() {
    let (mut p, key) = guardian_policy();
    as_owner(T0);
    p.remove_guardian_key(key.clone());
    as_key(&key, T0, 30);
    p.guardian_block(acc("scam.testnet"), None);
}

#[test]
fn removing_a_guardian_keeps_its_entries_for_the_owner_to_review() {
    let (mut p, key) = guardian_policy();
    as_key(&key, T0, 30);
    p.guardian_block(acc("scam.testnet"), None);
    as_owner(T0);
    p.remove_guardian_key(key);
    assert_eq!(p.get_guardians().len(), 0);
    assert_eq!(p.get_blocklist().len(), 1);
    p.unblock_recipient(acc("scam.testnet"));
    assert_eq!(p.get_blocklist().len(), 0);
}

#[test]
#[should_panic(expected = "This key is a guardian key")]
fn a_guardian_key_cannot_become_a_connection() {
    let (mut p, key) = guardian_policy();
    as_owner(T0);
    p.connect_agent_key("1".into(), key, "custom".into(), "x".into());
}

#[test]
#[should_panic(expected = "This key is a connected agent key")]
fn a_connected_key_cannot_become_a_guardian() {
    let (mut p, key) = connected_policy();
    as_owner(T0);
    p.add_guardian_key(key, "x".into());
}

#[test]
#[should_panic(expected = "Too many guardians")]
fn guardians_are_limited() {
    let mut p = readme_policy();
    as_owner(T0);
    for i in 0..=MAX_GUARDIANS as u8 {
        p.add_guardian_key(agent_key(100 + i), format!("watcher {i}"));
    }
}

#[test]
#[should_panic(expected = "Only the account itself can change its policy")]
fn only_the_owner_adds_guardians() {
    let mut p = readme_policy();
    set_env(registry(), 1, T0, 100);
    p.add_guardian_key(agent_key(1), "x".into());
}

// ---------------------------------------------------------------- x402

/// USDC has 6 decimals; amounts below are in cents for readability.
const USDC: u128 = 1_000_000;

fn usdc() -> AccountId {
    acc("usdc.testnet")
}

fn cents(n: u128) -> u128 {
    n * USDC / 100
}

fn x402(seller: &str, c: u128) -> Action {
    Action::X402Pay {
        asset: usdc(),
        pay_to: acc(seller),
        amount: U128(cents(c)),
        site: None,
        payee_agent: None,
    }
}

fn limit(per: u128, daily: u128) -> X402Limit {
    X402Limit {
        per_payment_cap: U128(cents(per)),
        daily_cap: U128(cents(daily)),
    }
}

fn seller(name: &str, per: u128, daily: u128) -> X402SellerInput {
    X402SellerInput {
        seller: acc(name),
        per_payment_cap: U128(cents(per)),
        daily_cap: U128(cents(daily)),
    }
}

/// The payment account of `agent_key(7)`: its 32 bytes as hex.
fn payment_account() -> AccountId {
    acc(&"07".repeat(32))
}

/// The connected policy with x402 on: a 1 USDC daily budget, `known.testnet`
/// approved at 20c per payment and 50c a day, and any other seller at 5c per
/// payment and 10c a day in total.
fn x402_policy() -> (AccountPolicy, PublicKey) {
    let (mut p, key) = connected_policy();
    as_owner(T0);
    p.set_x402_config(Some(usdc()), None);
    as_owner(T0);
    p.set_x402_rules(
        "1".into(),
        U128(cents(100)),
        vec![seller("known.testnet", 20, 50)],
        Some(limit(5, 10)),
        None,
        None,
    );
    (p, key)
}

/// Runs an x402 request through `on_authorized` with path `node("1", generation)`,
/// then settles the funding with `settle` (None leaves it in flight).
fn through_x402_with(
    p: &mut AccountPolicy,
    key: &PublicKey,
    action: Action,
    request: u64,
    generation: u64,
    settle: Option<bool>,
) -> Outcome {
    as_callback(T0);
    match p.on_authorized(
        String::from(key),
        action,
        rid(request),
        Some("Claude Desktop".into()),
        allowed(vec![node("1", generation)]),
    ) {
        PromiseOrValue::Value(outcome) => outcome,
        PromiseOrValue::Promise(_) => match settle {
            Some(success) => p.settle(&request_key("1", &rid(request)), success),
            None => Outcome::Settled {
                request_id: "in flight".into(),
            },
        },
    }
}

fn pay_x402(
    p: &mut AccountPolicy,
    key: &PublicKey,
    seller: &str,
    c: u128,
    request: u64,
) -> Outcome {
    through_x402_with(p, key, x402(seller, c), request, 10, Some(true))
}

#[test]
fn x402_payment_account_is_the_keys_implicit_account() {
    let (p, key) = x402_policy();
    assert_eq!(p.get_x402_account(key), Some(payment_account()));
    let secp = PublicKey::from_parts(CurveType::SECP256K1, vec![1; 64]).unwrap();
    assert_eq!(p.get_x402_account(secp), None);
}

#[test]
fn x402_listed_seller_settles_and_is_recorded_in_the_token() {
    let (mut p, key) = x402_policy();
    assert_eq!(pay_x402(&mut p, &key, "known.testnet", 20, 1), settled(1));
    let usage = p.get_x402_usage("1".into(), Some(acc("known.testnet")), None, None);
    assert_eq!(usage.mandate_used_today, U128(cents(20)));
    assert_eq!(usage.seller_used_today, Some(U128(cents(20))));
    assert_eq!(usage.unlisted_used_today, U128(0));
    assert_eq!(usage.account_used_today, U128(cents(20)));
    // NEAR budgets and reservations are untouched.
    let policy = p.get_policy();
    assert_eq!(policy.account_used_today, U128(0));
    assert_eq!(policy.reserved_total, U128(0));
    assert_eq!(p.get_usage("1".into(), None).mandate_used_today, U128(0));

    let activity = &p.get_activity(None, Some(1))[0];
    assert_eq!(activity.outcome, "settled");
    assert_eq!(activity.recipient, acc("known.testnet"));
    assert_eq!(activity.amount, U128(cents(20)));
    assert_eq!(
        activity.via,
        Some(Via::X402 {
            public_key: String::from(&key),
            label: "Claude on laptop".into(),
            payment_account: payment_account(),
            site: None,
            payee_agent: None,
        })
    );
    assert_eq!(
        p.get_request("1".into(), rid(1)).unwrap().status,
        RequestStatus::Settled
    );
}

#[test]
fn x402_listed_seller_caps_apply() {
    let (mut p, key) = x402_policy();
    assert_eq!(
        pay_x402(&mut p, &key, "known.testnet", 21, 1),
        denied(Reason::PerPaymentCap)
    );
    assert_eq!(pay_x402(&mut p, &key, "known.testnet", 20, 2), settled(2));
    assert_eq!(pay_x402(&mut p, &key, "known.testnet", 20, 3), settled(3));
    assert_eq!(
        pay_x402(&mut p, &key, "known.testnet", 20, 4),
        denied(Reason::RecipientDailyCap)
    );
    assert_eq!(pay_x402(&mut p, &key, "known.testnet", 10, 5), settled(5));
}

#[test]
fn x402_unlisted_sellers_share_one_small_budget() {
    let (mut p, key) = x402_policy();
    assert_eq!(
        pay_x402(&mut p, &key, "a.testnet", 6, 1),
        denied(Reason::PerPaymentCap)
    );
    assert_eq!(pay_x402(&mut p, &key, "a.testnet", 5, 2), settled(2));
    assert_eq!(pay_x402(&mut p, &key, "b.testnet", 5, 3), settled(3));
    // A third seller cannot get around the shared pool.
    assert_eq!(
        pay_x402(&mut p, &key, "c.testnet", 1, 4),
        denied(Reason::UnlistedDailyCap)
    );
    assert_eq!(
        p.get_x402_usage("1".into(), None, None, None)
            .unlisted_used_today,
        U128(cents(10))
    );
    // An approved seller still has its own room.
    assert_eq!(pay_x402(&mut p, &key, "known.testnet", 20, 5), settled(5));
}

#[test]
fn x402_without_an_unlisted_rule_refuses_unknown_sellers() {
    let (mut p, key) = x402_policy();
    as_owner(T0);
    p.set_x402_rules(
        "1".into(),
        U128(cents(100)),
        vec![seller("known.testnet", 20, 50)],
        None,
        None,
        None,
    );
    assert_eq!(
        pay_x402(&mut p, &key, "stranger.testnet", 1, 1),
        denied(Reason::RecipientNotApproved)
    );
    assert_eq!(pay_x402(&mut p, &key, "known.testnet", 1, 2), settled(2));
}

#[test]
fn x402_branch_and_account_caps_apply() {
    let (mut p, key) = x402_policy();
    as_owner(T0);
    p.set_x402_rules(
        "1".into(),
        U128(cents(30)),
        vec![seller("known.testnet", 20, 50)],
        Some(limit(5, 10)),
        None,
        None,
    );
    assert_eq!(pay_x402(&mut p, &key, "known.testnet", 20, 1), settled(1));
    assert_eq!(
        pay_x402(&mut p, &key, "known.testnet", 20, 2),
        denied(Reason::MandateDailyCap)
    );
    as_owner(T0);
    p.set_x402_config(Some(usdc()), Some(U128(cents(25))));
    assert_eq!(
        pay_x402(&mut p, &key, "known.testnet", 10, 3),
        denied(Reason::AccountDailyCap)
    );
    assert_eq!(pay_x402(&mut p, &key, "known.testnet", 5, 4), settled(4));
}

#[test]
fn x402_refuses_other_tokens_and_needs_x402_turned_on() {
    let (mut p, key) = x402_policy();
    let other = Action::X402Pay {
        asset: acc("other-token.testnet"),
        pay_to: acc("known.testnet"),
        amount: U128(cents(1)),
        site: None,
        payee_agent: None,
    };
    assert_eq!(
        through_x402_with(&mut p, &key, other, 1, 10, Some(true)),
        denied(Reason::AssetNotAccepted)
    );
    as_owner(T0);
    p.remove_x402_rules("1".into());
    assert_eq!(
        pay_x402(&mut p, &key, "known.testnet", 1, 2),
        denied(Reason::X402NotEnabled)
    );
    as_owner(T0);
    p.set_x402_config(None, None);
    assert_eq!(p.get_x402_config(), None);
    assert_eq!(
        pay_x402(&mut p, &key, "known.testnet", 1, 3),
        denied(Reason::X402NotEnabled)
    );
}

#[test]
fn x402_failed_funding_releases_the_reservation() {
    let (mut p, key) = x402_policy();
    assert_eq!(
        through_x402_with(&mut p, &key, x402("a.testnet", 5), 1, 10, Some(false)),
        Outcome::Failed { request_id: rid(1) }
    );
    let usage = p.get_x402_usage("1".into(), Some(acc("a.testnet")), None, None);
    assert_eq!(usage.mandate_used_today, U128(0));
    assert_eq!(usage.seller_used_today, Some(U128(0)));
    assert_eq!(usage.unlisted_used_today, U128(0));
    assert_eq!(usage.account_used_today, U128(0));
    // The released pool is usable again, and the request ID stays used.
    assert_eq!(pay_x402(&mut p, &key, "a.testnet", 5, 2), settled(2));
    assert_eq!(
        pay_x402(&mut p, &key, "b.testnet", 5, 1),
        denied(Reason::DuplicateRequest)
    );
}

#[test]
fn x402_never_pays_the_account_itself_or_the_payment_account() {
    let (mut p, key) = x402_policy();
    assert_eq!(
        pay_x402(&mut p, &key, &"07".repeat(32), 1, 1),
        denied(Reason::InvalidRequest)
    );
    assert_eq!(
        pay_x402(&mut p, &key, "alice.testnet", 1, 2),
        denied(Reason::InvalidRequest)
    );
}

#[test]
fn x402_respects_pause_blocklist_and_stale_mandates() {
    let (mut p, key) = x402_policy();
    assert_eq!(
        through_x402_with(&mut p, &key, x402("known.testnet", 1), 1, 11, Some(true)),
        denied(Reason::MandateStale)
    );
    as_owner(T0);
    p.block_recipient(acc("known.testnet"), None);
    assert_eq!(
        pay_x402(&mut p, &key, "known.testnet", 1, 2),
        denied(Reason::RecipientBlocked)
    );
    as_owner(T0);
    p.pause();
    assert_eq!(
        pay_x402(&mut p, &key, "a.testnet", 1, 3),
        denied(Reason::PaymentsPaused)
    );
}

#[test]
fn x402_denials_are_recorded_in_the_token() {
    let (mut p, key) = x402_policy();
    let denied_by_registry = Ok(Authorization::Denied {
        reason: Reason::CapExceeded,
        detail: None,
    });
    as_callback(T0);
    let outcome = p.on_authorized(
        String::from(&key),
        x402("known.testnet", 30),
        rid(1),
        None,
        denied_by_registry,
    );
    assert!(matches!(
        outcome,
        PromiseOrValue::Value(Outcome::Denied {
            reason: Reason::CapExceeded,
            ..
        })
    ));
    let activity = &p.get_activity(None, Some(1))[0];
    assert!(matches!(activity.via, Some(Via::X402 { .. })));
    assert_eq!(activity.amount, U128(cents(30)));
}

#[test]
fn x402_and_near_budgets_are_separate() {
    let (mut p, key) = x402_policy();
    assert_eq!(pay_x402(&mut p, &key, "known.testnet", 20, 1), settled(1));
    // A NEAR payment through the same connection uses only the NEAR budget.
    assert_eq!(
        through_connection(
            &mut p,
            &key,
            allowed(vec![node("1", 10)]),
            "vendor.testnet",
            2,
            2
        ),
        settled(2)
    );
    assert_eq!(
        p.get_usage("1".into(), None).mandate_used_today,
        U128(2 * NEAR)
    );
    assert_eq!(
        p.get_x402_usage("1".into(), None, None, None)
            .mandate_used_today,
        U128(cents(20))
    );
}

#[test]
fn zero_near_budget_mandates_allow_x402_only() {
    let (mut p, key) = x402_policy();
    as_owner(T0);
    p.set_mandate(
        "1".into(),
        vec![node("1", 10)],
        U128(0),
        None,
        false,
        vec![],
        None,
    );
    assert_eq!(
        through_connection(
            &mut p,
            &key,
            allowed(vec![node("1", 10)]),
            "vendor.testnet",
            1,
            1
        ),
        denied(Reason::RecipientNotApproved)
    );
    // The x402 rules are kept when the mandate is replaced.
    assert_eq!(pay_x402(&mut p, &key, "known.testnet", 20, 2), settled(2));
}

#[test]
#[should_panic(expected = "Approved recipients need a NEAR daily budget above zero")]
fn zero_near_budget_mandates_cannot_list_recipients() {
    let mut p = new_policy();
    as_owner(T0);
    p.set_mandate(
        "1".into(),
        vec![node("1", 10)],
        U128(0),
        None,
        false,
        vec![rule("vendor.testnet", 1, 2)],
        None,
    );
}

#[test]
#[should_panic(expected = "Approved recipients need a NEAR daily budget above zero")]
fn zero_near_budget_mandates_cannot_approve_recipients_later() {
    let mut p = new_policy();
    as_owner(T0);
    p.set_mandate(
        "1".into(),
        vec![node("1", 10)],
        U128(0),
        None,
        false,
        vec![],
        None,
    );
    as_owner(T0);
    p.approve_recipient(
        "1".into(),
        acc("vendor.testnet"),
        U128(NEAR),
        U128(2 * NEAR),
        None,
    );
}

#[test]
fn approving_and_removing_sellers_keeps_todays_usage() {
    let (mut p, key) = x402_policy();
    assert_eq!(pay_x402(&mut p, &key, "a.testnet", 5, 1), settled(1));
    as_owner(T0);
    p.approve_x402_seller(
        "1".into(),
        acc("a.testnet"),
        U128(cents(20)),
        U128(cents(24)),
    );
    // 5c already paid counts toward a's new 24c daily limit.
    assert_eq!(
        pay_x402(&mut p, &key, "a.testnet", 20, 2),
        denied(Reason::RecipientDailyCap)
    );
    assert_eq!(pay_x402(&mut p, &key, "a.testnet", 19, 3), settled(3));
    as_owner(T0);
    p.remove_x402_seller("1".into(), acc("a.testnet"));
    // Unlisted again: the shared pool (5c of 10c used) applies.
    assert_eq!(pay_x402(&mut p, &key, "a.testnet", 5, 4), settled(4));
    assert_eq!(
        pay_x402(&mut p, &key, "a.testnet", 1, 5),
        denied(Reason::UnlistedDailyCap)
    );
}

#[test]
fn x402_preview_runs_the_same_checks() {
    let (p, _) = x402_policy();
    as_callback(T0);
    let ctx = |action| ExecContext {
        path: vec![node("1", 10)],
        executor: acc("alice.testnet"),
        action,
        request_id: rid(9),
        expected_revision: None,
    };
    let ok = p.preview(ctx(x402("known.testnet", 20)));
    assert!(ok.allowed);
    assert_eq!(ok.mandates, vec!["1".to_string()]);
    assert!(!ok.needs_confirmation);
    let refused = p.preview(ctx(x402("known.testnet", 21)));
    assert_eq!(refused.reason, Some(Reason::PerPaymentCap));
}

#[test]
#[should_panic(expected = "Attach at least 125 Tgas to agent_execute for an x402 payment")]
fn agent_execute_needs_more_gas_for_x402() {
    let (mut p, key) = x402_policy();
    as_key(&key, T0, 100);
    let _ = p.agent_execute(x402("known.testnet", 1), rid(1), None);
}

#[test]
fn agent_execute_refuses_x402_for_keys_without_a_payment_account() {
    let (mut p, _) = x402_policy();
    let secp = PublicKey::from_parts(CurveType::SECP256K1, vec![1; 64]).unwrap();
    as_owner(T0);
    p.connect_agent_key("1".into(), secp.clone(), "custom".into(), "secp key".into());
    as_key(&secp, T0, 150);
    assert!(matches!(
        p.agent_execute(x402("known.testnet", 1), rid(1), None),
        PromiseOrValue::Value(Outcome::Denied {
            reason: Reason::InvalidRequest,
            ..
        })
    ));
}

#[test]
fn agent_execute_routes_x402_through_the_registry() {
    let (mut p, key) = x402_policy();
    as_key(&key, T0, 150);
    assert!(matches!(
        p.agent_execute(x402("known.testnet", 1), rid(1), None),
        PromiseOrValue::Promise(_)
    ));
}

#[test]
fn executor_mode_refuses_x402() {
    let (mut p, _) = x402_policy();
    set_env(registry(), 0, T0, 100);
    let ctx = ExecContext {
        path: vec![node("1", 10)],
        executor: acc("runner.testnet"),
        action: x402("known.testnet", 1),
        request_id: rid(1),
        expected_revision: None,
    };
    match p.on_execute(ctx) {
        PromiseOrValue::Value(Outcome::Denied { reason, detail }) => {
            assert_eq!(reason, Reason::InvalidRequest);
            assert_eq!(
                detail.as_deref(),
                Some("x402 payments need a connection key")
            );
        }
        _ => panic!("must not dispatch"),
    }
}

#[test]
#[should_panic(expected = "No mandate for agent")]
fn x402_rules_need_a_mandate() {
    let (mut p, _) = x402_policy();
    as_owner(T0);
    p.set_x402_rules("2".into(), U128(cents(100)), vec![], None, None, None);
}

#[test]
#[should_panic(expected = "A fixed mandate cannot be edited")]
fn x402_rules_cannot_change_a_fixed_mandate() {
    let mut p = new_policy();
    as_owner(T0);
    p.set_mandate(
        "1".into(),
        vec![node("1", 10)],
        U128(0),
        None,
        true,
        vec![],
        None,
    );
    as_owner(T0);
    p.set_x402_rules("1".into(), U128(cents(100)), vec![], None, None, None);
}

#[test]
#[should_panic(expected = "Unlisted sellers: the per-payment cap cannot exceed the daily cap")]
fn x402_limits_are_validated() {
    let (mut p, _) = x402_policy();
    as_owner(T0);
    p.set_x402_rules(
        "1".into(),
        U128(cents(100)),
        vec![],
        Some(limit(10, 5)),
        None,
        None,
    );
}

#[test]
#[should_panic(expected = "Only the account itself can change its policy")]
fn only_the_owner_sets_x402_rules() {
    let (mut p, _) = x402_policy();
    set_env(registry(), 1, T0, 100);
    p.set_x402_rules("1".into(), U128(cents(100)), vec![], None, None, None);
}

#[test]
#[should_panic(expected = "Turn x402 on first")]
fn x402_account_setup_needs_x402_on() {
    let (mut p, key) = connected_policy();
    as_owner(T0);
    let _ = p.setup_x402_account(key);
}

#[test]
#[should_panic(expected = "This key is not connected")]
fn x402_account_setup_needs_a_connected_key() {
    let (mut p, _) = x402_policy();
    as_owner(T0);
    let _ = p.setup_x402_account(agent_key(99));
}

#[test]
fn x402_account_setup_schedules_funding_and_registration() {
    let (mut p, key) = x402_policy();
    as_owner(T0);
    let _ = p.setup_x402_account(key);
}

// ---------------------------------------------------------------- x402 websites and agents

fn x402_labelled(seller: &str, c: u128, site: Option<&str>, agent: Option<(&str, &str)>) -> Action {
    Action::X402Pay {
        asset: usdc(),
        pay_to: acc(seller),
        amount: U128(cents(c)),
        site: site.map(String::from),
        payee_agent: agent.map(|(registry, id)| AgentRef {
            registry: acc(registry),
            agent_id: id.into(),
        }),
    }
}

fn site(name: &str, per: u128, daily: u128, pay_to: Option<&str>) -> X402SiteInput {
    X402SiteInput {
        site: name.into(),
        per_payment_cap: U128(cents(per)),
        daily_cap: U128(cents(daily)),
        pay_to: pay_to.map(acc),
    }
}

fn payee_agent(
    registry: &str,
    id: &str,
    per: u128,
    daily: u128,
    generation: Option<u64>,
) -> X402AgentInput {
    X402AgentInput {
        registry: acc(registry),
        agent_id: id.into(),
        per_payment_cap: U128(cents(per)),
        daily_cap: U128(cents(daily)),
        generation,
    }
}

/// `x402_policy` plus an approved website, a pinned website, and Bob's agent #7 at generation 3.
fn labelled_policy() -> (AccountPolicy, PublicKey) {
    let (mut p, key) = x402_policy();
    as_owner(T0);
    p.set_x402_rules(
        "1".into(),
        U128(cents(100)),
        vec![seller("known.testnet", 20, 50)],
        Some(limit(5, 10)),
        Some(vec![
            site("api.example.com", 20, 50, None),
            site("pinned.example.com", 20, 50, Some("pinned.testnet")),
        ]),
        Some(vec![payee_agent(
            "agents.bob.testnet",
            "7",
            30,
            60,
            Some(3),
        )]),
    );
    (p, key)
}

fn bob_agent(
    holder: &str,
    state: &str,
    generation: u64,
) -> Result<Option<PayeeAgentView>, PromiseError> {
    Ok(Some(PayeeAgentView {
        holder: Some(acc(holder)),
        status: PayeeAgentStatus {
            state: state.into(),
        },
        generation: U64(generation),
    }))
}

/// Runs an agent-claim request: `on_authorized` reserves and asks the registry,
/// then `answer` is fed to `on_x402_payee`, then a dispatched funding settles.
fn through_payee_check(
    p: &mut AccountPolicy,
    key: &PublicKey,
    action: Action,
    request: u64,
    answer: Result<Option<PayeeAgentView>, PromiseError>,
) -> Outcome {
    as_callback(T0);
    let PromiseOrValue::Promise(_) = p.on_authorized(
        String::from(key),
        action.clone(),
        rid(request),
        None,
        allowed(vec![node("1", 10)]),
    ) else {
        panic!("an agent claim must be checked against the registry");
    };
    let Action::X402Pay { payee_agent, .. } = action else {
        unreachable!()
    };
    as_callback(T0);
    match p.on_x402_payee(
        request_key("1", &rid(request)),
        payee_agent.unwrap(),
        vec![3],
        answer,
    ) {
        PromiseOrValue::Value(outcome) => outcome,
        PromiseOrValue::Promise(_) => p.settle(&request_key("1", &rid(request)), true),
    }
}

#[test]
fn an_approved_website_has_its_own_limits() {
    let (mut p, key) = labelled_policy();
    // Unlabelled, an unknown seller only gets the small unlisted pool.
    assert_eq!(
        pay_x402(&mut p, &key, "site-owner.testnet", 20, 1),
        denied(Reason::PerPaymentCap)
    );
    let paid = through_x402_with(
        &mut p,
        &key,
        x402_labelled("site-owner.testnet", 20, Some("api.example.com"), None),
        2,
        10,
        Some(true),
    );
    assert_eq!(paid, settled(2));
    let usage = p.get_x402_usage("1".into(), None, Some("api.example.com".into()), None);
    assert_eq!(usage.site_used_today, Some(U128(cents(20))));
    assert_eq!(usage.unlisted_used_today, U128(0));
    let activity = &p.get_activity(None, Some(1))[0];
    assert!(
        matches!(&activity.via, Some(Via::X402 { site: Some(s), .. }) if s == "api.example.com")
    );
}

#[test]
fn a_pinned_website_must_be_paid_at_its_account() {
    let (mut p, key) = labelled_policy();
    assert_eq!(
        through_x402_with(
            &mut p,
            &key,
            x402_labelled("attacker.testnet", 1, Some("pinned.example.com"), None),
            1,
            10,
            Some(true)
        ),
        denied(Reason::SitePayeeMismatch)
    );
    assert_eq!(
        through_x402_with(
            &mut p,
            &key,
            x402_labelled("pinned.testnet", 20, Some("pinned.example.com"), None),
            2,
            10,
            Some(true)
        ),
        settled(2)
    );
}

#[test]
fn an_approved_seller_account_wins_over_its_website() {
    let (mut p, key) = labelled_policy();
    assert_eq!(
        through_x402_with(
            &mut p,
            &key,
            x402_labelled("known.testnet", 20, Some("api.example.com"), None),
            1,
            10,
            Some(true)
        ),
        settled(1)
    );
    let usage = p.get_x402_usage(
        "1".into(),
        Some(acc("known.testnet")),
        Some("api.example.com".into()),
        None,
    );
    assert_eq!(usage.seller_used_today, Some(U128(cents(20))));
    assert_eq!(usage.site_used_today, Some(U128(0)));
}

#[test]
fn an_approved_agent_is_paid_after_the_registry_confirms_its_holder() {
    let (mut p, key) = labelled_policy();
    let action = x402_labelled("bob.testnet", 30, None, Some(("agents.bob.testnet", "7")));
    assert_eq!(
        through_payee_check(
            &mut p,
            &key,
            action,
            1,
            bob_agent("bob.testnet", "active", 3)
        ),
        settled(1)
    );
    let usage = p.get_x402_usage("1".into(), None, None, Some("7@agents.bob.testnet".into()));
    assert_eq!(usage.payee_used_today, Some(U128(cents(30))));
    let activity = &p.get_activity(None, Some(1))[0];
    assert!(
        matches!(&activity.via, Some(Via::X402 { payee_agent: Some(a), .. }) if a == "7@agents.bob.testnet")
    );
}

#[test]
fn an_agent_claim_that_does_not_check_out_is_refused_and_released() {
    let (mut p, key) = labelled_policy();
    for (request, (answer, why)) in [
        (bob_agent("mallory.testnet", "active", 3), "does not hold"),
        (bob_agent("bob.testnet", "active", 4), "changed hands"),
        (bob_agent("bob.testnet", "paused", 3), "paused"),
        (Ok(None), "no such agent"),
        (Err(PromiseError::Failed), "could not be read"),
    ]
    .into_iter()
    .enumerate()
    {
        let request = request as u64 + 1;
        let action = x402_labelled("bob.testnet", 30, None, Some(("agents.bob.testnet", "7")));
        match through_payee_check(&mut p, &key, action, request, answer) {
            Outcome::Denied { reason, detail } => {
                assert_eq!(reason, Reason::AgentPayeeMismatch);
                assert!(detail.unwrap().contains(why), "{why}");
            }
            other => panic!("expected a denial, got {other:?}"),
        }
        let usage = p.get_x402_usage("1".into(), None, None, Some("7@agents.bob.testnet".into()));
        assert_eq!(usage.mandate_used_today, U128(0), "{why}");
        assert_eq!(usage.payee_used_today, Some(U128(0)), "{why}");
        assert_eq!(
            p.get_request("1".into(), rid(request)).unwrap().status,
            RequestStatus::Declined
        );
        assert_eq!(
            p.get_activity(None, Some(1))[0].reason,
            Some(Reason::AgentPayeeMismatch)
        );
    }
}

#[test]
fn an_agent_claim_without_an_agent_rule_needs_no_registry_check() {
    let (mut p, key) = labelled_policy();
    // Agent #8 is not approved: the seller's claim is ignored and the unlisted pool applies.
    assert_eq!(
        through_x402_with(
            &mut p,
            &key,
            x402_labelled("carol.testnet", 5, None, Some(("agents.bob.testnet", "8"))),
            1,
            10,
            Some(true)
        ),
        settled(1)
    );
    assert_eq!(
        p.get_x402_usage("1".into(), None, None, None)
            .unlisted_used_today,
        U128(cents(5))
    );
}

#[test]
#[should_panic(expected = "Attach at least 145 Tgas to agent_execute to pay an agent")]
fn paying_an_agent_needs_gas_for_the_registry_check() {
    let (mut p, key) = labelled_policy();
    as_key(&key, T0, 130);
    let _ = p.agent_execute(
        x402_labelled("bob.testnet", 1, None, Some(("agents.bob.testnet", "7"))),
        rid(1),
        None,
    );
}

#[test]
fn malformed_website_labels_are_refused_before_the_registry() {
    let (mut p, key) = labelled_policy();
    as_key(&key, T0, 200);
    assert!(matches!(
        p.agent_execute(
            x402_labelled("a.testnet", 1, Some("https://evil.com/path"), None),
            rid(1),
            None
        ),
        PromiseOrValue::Value(Outcome::Denied {
            reason: Reason::InvalidRequest,
            ..
        })
    ));
}

#[test]
fn websites_and_agents_can_be_approved_and_removed_one_by_one() {
    let (mut p, _) = x402_policy();
    as_owner(T0);
    p.approve_x402_site(
        "1".into(),
        "data.example.org".into(),
        U128(cents(10)),
        U128(cents(20)),
        None,
    );
    as_owner(T0);
    p.approve_x402_agent(
        "1".into(),
        acc("agents.bob.testnet"),
        "9".into(),
        U128(cents(10)),
        U128(cents(20)),
        Some(1),
    );
    let rules = p.get_x402_rules("1".into()).unwrap();
    assert!(rules.sites.contains_key("data.example.org"));
    assert_eq!(rules.agents["9@agents.bob.testnet"].generation, Some(1));
    as_owner(T0);
    p.remove_x402_site("1".into(), "data.example.org".into());
    as_owner(T0);
    p.remove_x402_agent("1".into(), "9@agents.bob.testnet".into());
    let rules = p.get_x402_rules("1".into()).unwrap();
    assert!(rules.sites.is_empty() && rules.agents.is_empty());
}

#[test]
#[should_panic(expected = "is not a website host")]
fn website_rules_need_a_plain_host() {
    let (mut p, _) = x402_policy();
    as_owner(T0);
    p.approve_x402_site(
        "1".into(),
        "https://example.com".into(),
        U128(1),
        U128(1),
        None,
    );
}

#[test]
fn the_owner_can_upgrade_the_policy_from_a_wallet_call() {
    let mut p = readme_policy();
    as_owner(T0);
    let _ = p.upgrade_code(vec![0, 97, 115, 109].into());
}

#[test]
#[should_panic(expected = "Only the account itself can change its policy")]
fn only_the_owner_upgrades_the_policy() {
    let mut p = readme_policy();
    set_env(registry(), 1, T0, 100);
    let _ = p.upgrade_code(vec![1].into());
}
