use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;
use nearfirewall_types::CapTransferNear;

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const T0: u64 = 1_700_000_000_000_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn alice() -> AccountId {
    acc("alice.testnet")
}
fn bob() -> AccountId {
    acc("bob.testnet")
}
fn runner() -> AccountId {
    acc("runner.testnet")
}

fn call(predecessor: &AccountId, deposit: u128, now: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("registry.testnet"))
        .signer_account_id(predecessor.clone())
        .predecessor_account_id(predecessor.clone())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(now)
        .account_balance(NearToken::from_yoctonear(1000 * NEAR));
    testing_env!(b.build());
}

fn caps(max_near: u128) -> Capabilities {
    Capabilities {
        transfer_near: Some(CapTransferNear {
            max_per_payment: U128(max_near * NEAR),
        }),
    }
}

fn transfer(recipient: &str, amount_near: u128) -> Action {
    Action::TransferNear {
        recipient: acc(recipient),
        amount: U128(amount_near * NEAR),
    }
}

fn rid(n: u64) -> String {
    format!("{n:064x}")
}

fn setup() -> Registry {
    call(&alice(), 0, T0);
    Registry::new(alice())
}

fn register(
    r: &mut Registry,
    who: &AccountId,
    handle: &str,
    executor: &str,
    max: u128,
) -> AgentView {
    call(who, NEAR, T0);
    r.register_agent(
        handle.into(),
        Some(acc(executor)),
        caps(max),
        None,
        None,
        Some("test agent".into()),
    )
}

fn child(
    r: &mut Registry,
    who: &AccountId,
    parent: &str,
    label: &str,
    executor: &str,
    max: u128,
) -> AgentView {
    call(who, NEAR, T0);
    r.create_child(
        parent.into(),
        label.into(),
        Some(acc(executor)),
        caps(max),
        None,
        None,
        None,
    )
}

fn exec_as(
    r: &mut Registry,
    executor: &AccountId,
    payer: &AccountId,
    agent: &str,
    action: Action,
    n: u64,
) -> Option<Outcome> {
    call(executor, 0, T0);
    match r.execute(payer.clone(), agent.into(), None, action, rid(n), None) {
        PromiseOrValue::Value(outcome) => Some(outcome),
        PromiseOrValue::Promise(_) => None, // routed to the payer
    }
}

fn denied(reason: Reason) -> Option<Outcome> {
    Some(Outcome::denied(reason))
}

fn reason_of(outcome: Option<Outcome>) -> Option<Reason> {
    match outcome {
        Some(Outcome::Denied { reason, .. }) => Some(reason),
        _ => None,
    }
}

// ---------------------------------------------------------------- registration and NFT

#[test]
fn register_mints_a_token_to_the_caller() {
    let mut r = setup();
    let view = register(&mut r, &alice(), "market-agent", "runner.testnet", 3);
    assert_eq!(view.agent_id, "1");
    assert_eq!(view.holder, Some(alice()));
    assert_eq!(view.executor, Some(runner()));
    assert_eq!(view.status, Status::Active);
    assert_eq!(view.depth, 0);
    let tokens = r.nft_tokens_for_owner(alice(), None, None);
    assert_eq!(tokens.len(), 1);
    assert_eq!(
        tokens[0].metadata.as_ref().unwrap().title.as_deref(),
        Some("market-agent")
    );
    assert_eq!(r.resolve("market-agent".into()).unwrap().agent_id, "1");
    assert_eq!(r.nft_metadata().symbol, "AGENT");
}

#[test]
fn ids_and_generations_are_unique_and_sequential() {
    let mut r = setup();
    let a = register(&mut r, &alice(), "one", "runner.testnet", 3);
    let b = register(&mut r, &alice(), "two", "runner.testnet", 3);
    assert_eq!((a.agent_id.as_str(), b.agent_id.as_str()), ("1", "2"));
    assert_ne!(a.generation, b.generation);
}

#[test]
#[should_panic(expected = "This handle is taken")]
fn handles_are_unique() {
    let mut r = setup();
    register(&mut r, &alice(), "market-agent", "runner.testnet", 3);
    register(&mut r, &alice(), "market-agent", "runner2.testnet", 3);
}

#[test]
#[should_panic(expected = "A handle label must be")]
fn handles_are_validated() {
    let mut r = setup();
    register(&mut r, &alice(), "Market_Agent", "runner.testnet", 3);
}

#[test]
#[should_panic(expected = "The executor must be a separate account")]
fn executor_cannot_be_the_holder() {
    let mut r = setup();
    register(&mut r, &alice(), "market-agent", "alice.testnet", 3);
}

#[test]
#[should_panic(expected = "to cover storage")]
fn registration_requires_a_storage_deposit() {
    let mut r = setup();
    call(&alice(), 1, T0);
    r.register_agent(
        "market-agent".into(),
        Some(runner()),
        caps(3),
        None,
        None,
        None,
    );
}

#[test]
fn transfer_advances_the_generation() {
    let mut r = setup();
    let before = register(&mut r, &alice(), "market-agent", "runner.testnet", 3);
    call(&alice(), 1, T0);
    r.nft_transfer(bob(), "1".into(), None, None);
    let after = r.get_agent("1".into()).unwrap();
    assert_eq!(after.holder, Some(bob()));
    assert!(after.generation.0 > before.generation.0);
    assert_eq!(r.get_path("1".into())[0].generation, after.generation.0);
}

#[test]
#[should_panic(expected = "This agent is non-transferable")]
fn no_transfer_lock_blocks_transfers() {
    let mut r = setup();
    register(&mut r, &alice(), "market-agent", "runner.testnet", 3);
    call(&alice(), 1, T0);
    r.burn_locks("1".into(), LOCK_NO_TRANSFER);
    r.nft_transfer(bob(), "1".into(), None, None);
}

#[test]
#[should_panic(expected = "This agent is non-transferable")]
fn no_transfer_lock_blocks_approvals() {
    let mut r = setup();
    call(&alice(), NEAR, T0);
    r.register_agent(
        "market-agent".into(),
        Some(runner()),
        caps(3),
        None,
        Some(LOCK_NO_TRANSFER),
        None,
    );
    call(&alice(), NEAR, T0);
    r.nft_approve("1".into(), bob(), None);
}

#[test]
#[should_panic(expected = "cannot be transferred to its own executor")]
fn cannot_transfer_to_the_executor() {
    let mut r = setup();
    register(&mut r, &alice(), "market-agent", "runner.testnet", 3);
    call(&alice(), 1, T0);
    r.nft_transfer(runner(), "1".into(), None, None);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn function_call_keys_cannot_transfer() {
    // Function-call keys cannot attach deposits, so a zero-deposit call is what they can send.
    let mut r = setup();
    register(&mut r, &alice(), "market-agent", "runner.testnet", 3);
    call(&alice(), 0, T0);
    r.nft_transfer(bob(), "1".into(), None, None);
}

#[test]
#[should_panic(expected = "Unsupported lock")]
fn unknown_locks_are_rejected() {
    let mut r = setup();
    register(&mut r, &alice(), "market-agent", "runner.testnet", 3);
    call(&alice(), 1, T0);
    r.burn_locks("1".into(), 1 << 7);
}

// ---------------------------------------------------------------- execute

#[test]
fn executor_routes_to_a_payer_on_the_path() {
    let mut r = setup();
    register(&mut r, &alice(), "market-agent", "runner.testnet", 3);
    assert_eq!(
        exec_as(
            &mut r,
            &runner(),
            &alice(),
            "1",
            transfer("vendor.testnet", 2),
            1
        ),
        None
    );
    let activity = r.get_activity("1".into(), None);
    assert_eq!(activity[0].outcome, "routed");
}

#[test]
fn only_the_executor_can_execute() {
    let mut r = setup();
    register(&mut r, &alice(), "market-agent", "runner.testnet", 3);
    assert_eq!(
        exec_as(
            &mut r,
            &bob(),
            &alice(),
            "1",
            transfer("vendor.testnet", 1),
            1
        ),
        denied(Reason::ExecutorMismatch)
    );
    assert_eq!(
        exec_as(
            &mut r,
            &alice(),
            &alice(),
            "1",
            transfer("vendor.testnet", 1),
            1
        ),
        denied(Reason::ExecutorMismatch)
    );
    // Unauthenticated callers leave no trace.
    assert!(r.get_activity("1".into(), None).is_empty());
    assert_eq!(
        exec_as(
            &mut r,
            &runner(),
            &alice(),
            "99",
            transfer("vendor.testnet", 1),
            1
        ),
        denied(Reason::AgentNotFound)
    );
}

#[test]
fn payer_must_hold_a_node_on_the_path() {
    let mut r = setup();
    register(&mut r, &alice(), "market-agent", "runner.testnet", 3);
    assert_eq!(
        exec_as(
            &mut r,
            &runner(),
            &bob(),
            "1",
            transfer("vendor.testnet", 1),
            1
        ),
        denied(Reason::PayerNotAuthorized)
    );
}

#[test]
fn capability_caps_apply() {
    let mut r = setup();
    register(&mut r, &alice(), "market-agent", "runner.testnet", 3);
    assert_eq!(
        exec_as(
            &mut r,
            &runner(),
            &alice(),
            "1",
            transfer("vendor.testnet", 4),
            1
        ),
        denied(Reason::CapExceeded)
    );
    call(&alice(), 1, T0);
    r.set_capabilities("1".into(), Capabilities::default());
    assert_eq!(
        exec_as(
            &mut r,
            &runner(),
            &alice(),
            "1",
            transfer("vendor.testnet", 1),
            2
        ),
        denied(Reason::ActionNotAllowed)
    );
}

#[test]
fn invalid_request_ids_and_grants_are_rejected() {
    let mut r = setup();
    register(&mut r, &alice(), "market-agent", "runner.testnet", 3);
    call(&runner(), 0, T0);
    let bad = r.execute(
        alice(),
        "1".into(),
        None,
        transfer("vendor.testnet", 1),
        "xyz".into(),
        None,
    );
    assert!(matches!(
        bad,
        PromiseOrValue::Value(Outcome::Denied {
            reason: Reason::InvalidRequest,
            ..
        })
    ));
    let grant = r.execute(
        alice(),
        "1".into(),
        Some("g1".into()),
        transfer("vendor.testnet", 1),
        rid(1),
        None,
    );
    assert!(matches!(
        grant,
        PromiseOrValue::Value(Outcome::Denied {
            reason: Reason::PayerNotAuthorized,
            ..
        })
    ));
}

#[test]
fn paused_agents_are_rejected_until_resumed() {
    let mut r = setup();
    register(&mut r, &alice(), "market-agent", "runner.testnet", 3);
    call(&alice(), 1, T0);
    r.pause("1".into());
    assert_eq!(
        exec_as(
            &mut r,
            &runner(),
            &alice(),
            "1",
            transfer("vendor.testnet", 1),
            1
        ),
        denied(Reason::AgentPaused)
    );
    call(&alice(), 1, T0);
    r.resume("1".into());
    assert_eq!(
        exec_as(
            &mut r,
            &runner(),
            &alice(),
            "1",
            transfer("vendor.testnet", 1),
            2
        ),
        None
    );
}

#[test]
fn expired_agents_are_rejected() {
    let mut r = setup();
    call(&alice(), NEAR, T0);
    r.register_agent(
        "market-agent".into(),
        Some(runner()),
        caps(3),
        Some(T0 + 100),
        None,
        None,
    );
    call(&runner(), 0, T0 + 100);
    let outcome = r.execute(
        alice(),
        "1".into(),
        None,
        transfer("vendor.testnet", 1),
        rid(1),
        None,
    );
    assert!(matches!(
        outcome,
        PromiseOrValue::Value(Outcome::Denied {
            reason: Reason::AgentExpired,
            ..
        })
    ));
}

#[test]
fn new_executor_takes_over_and_generation_advances() {
    let mut r = setup();
    let before = register(&mut r, &alice(), "market-agent", "runner.testnet", 3);
    call(&alice(), 1, T0);
    r.set_executor("1".into(), Some(acc("runner2.testnet")));
    let after = r.get_agent("1".into()).unwrap();
    assert!(after.generation.0 > before.generation.0);
    assert_eq!(
        exec_as(
            &mut r,
            &runner(),
            &alice(),
            "1",
            transfer("vendor.testnet", 1),
            1
        ),
        denied(Reason::ExecutorMismatch)
    );
    assert_eq!(
        exec_as(
            &mut r,
            &acc("runner2.testnet"),
            &alice(),
            "1",
            transfer("vendor.testnet", 1),
            2
        ),
        None
    );
}

#[test]
fn activity_is_bounded() {
    let mut r = setup();
    register(&mut r, &alice(), "market-agent", "runner.testnet", 3);
    for n in 0..(ACTIVITY_SIZE + 10) {
        exec_as(
            &mut r,
            &runner(),
            &alice(),
            "1",
            transfer("vendor.testnet", 9),
            n,
        );
    }
    let activity = r.get_activity("1".into(), Some(1000));
    assert_eq!(activity.len() as u64, ACTIVITY_SIZE);
    assert_eq!(activity[0].seq, ACTIVITY_SIZE + 9);
    assert_eq!(activity[0].reason, Some(Reason::CapExceeded));
}

// ---------------------------------------------------------------- tree

#[test]
fn children_live_under_their_parent() {
    let mut r = setup();
    register(&mut r, &alice(), "desk", "runner.testnet", 3);
    let bot = child(&mut r, &alice(), "1", "bot-1", "runner-1.testnet", 2);
    assert_eq!(bot.handle, "bot-1.desk");
    assert_eq!(bot.holder, Some(alice()));
    assert_eq!(bot.parent.as_deref(), Some("1"));
    assert_eq!(bot.depth, 1);
    let path = r.get_path(bot.agent_id.clone());
    assert_eq!(
        path.iter().map(|n| n.agent_id.as_str()).collect::<Vec<_>>(),
        vec!["1", "2"]
    );
    assert_eq!(r.get_children("1".into(), None, None).len(), 1);
    assert_eq!(
        exec_as(
            &mut r,
            &acc("runner-1.testnet"),
            &alice(),
            "2",
            transfer("vendor.testnet", 2),
            1
        ),
        None
    );
}

#[test]
#[should_panic(expected = "A child cannot be wider than its parent")]
fn children_cannot_be_wider() {
    let mut r = setup();
    register(&mut r, &alice(), "desk", "runner.testnet", 3);
    child(&mut r, &alice(), "1", "bot-1", "runner-1.testnet", 5);
}

#[test]
#[should_panic(expected = "A child cannot expire later than its parent")]
fn children_cannot_outlive_their_parent() {
    let mut r = setup();
    call(&alice(), NEAR, T0);
    r.register_agent(
        "desk".into(),
        Some(runner()),
        caps(3),
        Some(T0 + 1000),
        None,
        None,
    );
    call(&alice(), NEAR, T0);
    r.create_child(
        "1".into(),
        "bot-1".into(),
        Some(acc("runner-1.testnet")),
        caps(1),
        None,
        None,
        None,
    );
}

#[test]
#[should_panic(expected = "deeper than 8 levels")]
fn depth_is_limited_to_eight() {
    let mut r = setup();
    register(&mut r, &alice(), "l0", "runner.testnet", 3);
    for depth in 1..MAX_DEPTH {
        let parent = depth.to_string();
        child(
            &mut r,
            &alice(),
            &parent,
            &format!("l{depth}"),
            "runner.testnet",
            3,
        );
    }
    let deepest = r.get_agent(MAX_DEPTH.to_string()).unwrap();
    assert_eq!(deepest.depth as usize, MAX_DEPTH - 1);
    assert_eq!(r.get_path(deepest.agent_id.clone()).len(), MAX_DEPTH);
    child(
        &mut r,
        &alice(),
        &MAX_DEPTH.to_string(),
        "too-deep",
        "runner.testnet",
        3,
    );
}

#[test]
fn depth_eight_executes_with_a_full_path() {
    let mut r = setup();
    register(&mut r, &alice(), "l0", "runner.testnet", 3);
    for depth in 1..MAX_DEPTH {
        child(
            &mut r,
            &alice(),
            &depth.to_string(),
            &format!("l{depth}"),
            "runner.testnet",
            3,
        );
    }
    assert_eq!(
        exec_as(
            &mut r,
            &runner(),
            &alice(),
            "8",
            transfer("vendor.testnet", 1),
            1
        ),
        None
    );
}

#[test]
fn pausing_a_parent_stops_the_branch() {
    let mut r = setup();
    register(&mut r, &alice(), "desk", "runner.testnet", 3);
    child(&mut r, &alice(), "1", "bot-1", "runner-1.testnet", 3);
    call(&alice(), 1, T0);
    r.pause("1".into());
    assert_eq!(
        exec_as(
            &mut r,
            &acc("runner-1.testnet"),
            &alice(),
            "2",
            transfer("vendor.testnet", 1),
            1
        ),
        denied(Reason::BranchPaused)
    );
}

#[test]
fn narrowing_a_parent_narrows_existing_children() {
    let mut r = setup();
    register(&mut r, &alice(), "desk", "runner.testnet", 3);
    child(&mut r, &alice(), "1", "bot-1", "runner-1.testnet", 3);
    call(&alice(), 1, T0);
    r.set_capabilities("1".into(), caps(1));
    let outcome = exec_as(
        &mut r,
        &acc("runner-1.testnet"),
        &alice(),
        "2",
        transfer("vendor.testnet", 2),
        1,
    );
    assert_eq!(reason_of(outcome), Some(Reason::CapExceeded));
}

#[test]
#[should_panic(expected = "Only a holder at or above the pausing level can resume")]
fn a_leaf_holder_cannot_resume_an_ancestor_pause() {
    let mut r = setup();
    register(&mut r, &alice(), "desk", "runner.testnet", 3);
    child(&mut r, &alice(), "1", "bot-1", "runner-1.testnet", 3);
    call(&alice(), 1, T0);
    r.nft_transfer(bob(), "2".into(), None, None);
    r.pause("2".into()); // Alice holds the parent, so she pauses at depth 0.
    call(&bob(), 1, T0);
    r.resume("2".into());
}

#[test]
fn an_ancestor_holder_keeps_control_after_a_child_transfer() {
    let mut r = setup();
    register(&mut r, &alice(), "desk", "runner.testnet", 3);
    child(&mut r, &alice(), "1", "bot-1", "runner-1.testnet", 3);
    call(&alice(), 1, T0);
    r.nft_transfer(bob(), "2".into(), None, None);
    r.set_executor("2".into(), Some(acc("runner-9.testnet")));
    assert_eq!(
        r.get_agent("2".into()).unwrap().executor,
        Some(acc("runner-9.testnet"))
    );
    // Bob holds the leaf, so he is on the path and may act as payer.
    assert_eq!(
        exec_as(
            &mut r,
            &acc("runner-9.testnet"),
            &bob(),
            "2",
            transfer("vendor.testnet", 1),
            1
        ),
        None
    );
}

#[test]
fn a_transferred_leaf_cannot_spend_from_the_previous_holder() {
    let mut r = setup();
    register(&mut r, &alice(), "desk", "runner.testnet", 3);
    child(&mut r, &alice(), "1", "bot-1", "runner-1.testnet", 3);
    call(&alice(), 1, T0);
    r.nft_transfer(bob(), "2".into(), None, None);
    // Alice still holds the parent, but no longer the agent making the request.
    assert_eq!(
        exec_as(
            &mut r,
            &acc("runner-1.testnet"),
            &alice(),
            "2",
            transfer("vendor.testnet", 1),
            1
        ),
        denied(Reason::PayerNotAuthorized)
    );
    // The new holder rotating the executor does not help either.
    call(&bob(), 1, T0);
    r.set_executor("2".into(), Some(acc("bob-runner.testnet")));
    assert_eq!(
        exec_as(
            &mut r,
            &acc("bob-runner.testnet"),
            &alice(),
            "2",
            transfer("vendor.testnet", 1),
            2
        ),
        denied(Reason::PayerNotAuthorized)
    );
}

#[test]
fn removing_a_parent_stops_the_branch_and_burns_the_token() {
    let mut r = setup();
    register(&mut r, &alice(), "desk", "runner.testnet", 3);
    child(&mut r, &alice(), "1", "bot-1", "runner-1.testnet", 3);
    call(&alice(), 1, T0);
    r.remove_agent("1".into());
    assert_eq!(r.get_agent("1".into()).unwrap().holder, None);
    assert!(r.nft_token("1".into()).is_none());
    assert_eq!(r.nft_tokens_for_owner(alice(), None, None).len(), 1);
    assert_eq!(
        exec_as(
            &mut r,
            &acc("runner-1.testnet"),
            &alice(),
            "2",
            transfer("vendor.testnet", 1),
            1
        ),
        denied(Reason::BranchRemoved)
    );
}

#[test]
#[should_panic(expected = "This handle is taken")]
fn removed_handles_stay_reserved() {
    let mut r = setup();
    register(&mut r, &alice(), "desk", "runner.testnet", 3);
    call(&alice(), 1, T0);
    r.remove_agent("1".into());
    register(&mut r, &alice(), "desk", "runner.testnet", 3);
}

#[test]
#[should_panic(expected = "Only the holder of this agent or one of its ancestors")]
fn strangers_have_no_authority() {
    let mut r = setup();
    register(&mut r, &alice(), "desk", "runner.testnet", 3);
    call(&bob(), 1, T0);
    r.pause("1".into());
}

#[test]
#[should_panic(expected = "Expiry can only be extended")]
fn expiry_never_moves_earlier() {
    let mut r = setup();
    call(&alice(), NEAR, T0);
    r.register_agent(
        "desk".into(),
        Some(runner()),
        caps(3),
        Some(T0 + 1000),
        None,
        None,
    );
    call(&alice(), 1, T0);
    r.extend_expiry("1".into(), Some(T0 + 2000));
    r.extend_expiry("1".into(), Some(T0 + 1500));
}

#[test]
#[should_panic(expected = "capabilities can only narrow")]
fn no_capability_raise_lock() {
    let mut r = setup();
    register(&mut r, &alice(), "desk", "runner.testnet", 3);
    call(&alice(), 1, T0);
    r.burn_locks("1".into(), LOCK_NO_CAPABILITY_RAISE);
    r.set_capabilities("1".into(), caps(2));
    r.set_capabilities("1".into(), caps(5));
}

// ---------------------------------------------------------------- records

#[test]
fn records_round_trip_and_survive_transfer() {
    let mut r = setup();
    register(&mut r, &alice(), "desk", "runner.testnet", 3);
    call(&alice(), NEAR, T0);
    r.set_record(
        "1".into(),
        "profile.description".into(),
        "Pays approved vendors".into(),
    );
    call(&alice(), NEAR, T0);
    r.set_record("1".into(), "mcp.endpoint".into(), "stdio".into());
    assert_eq!(r.get_records("1".into(), None, None).len(), 2);
    call(&alice(), 1, T0);
    r.nft_transfer(bob(), "1".into(), None, None);
    assert_eq!(
        r.get_record("1".into(), "mcp.endpoint".into()).as_deref(),
        Some("stdio")
    );
    call(&bob(), NEAR, T0);
    r.set_record(
        "1".into(),
        "mcp.endpoint".into(),
        "https://agent.example".into(),
    );
    call(&bob(), 1, T0);
    r.remove_record("1".into(), "profile.description".into());
    let records = r.get_records("1".into(), None, None);
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].value, "https://agent.example");
}

#[test]
#[should_panic(expected = "Only the holder can write records")]
fn only_the_holder_writes_records() {
    let mut r = setup();
    register(&mut r, &alice(), "desk", "runner.testnet", 3);
    call(&bob(), NEAR, T0);
    r.set_record("1".into(), "profile.description".into(), "x".into());
}

#[test]
#[should_panic(expected = "A record key must be <namespace>.<name>")]
fn record_keys_need_a_namespace() {
    let mut r = setup();
    register(&mut r, &alice(), "desk", "runner.testnet", 3);
    call(&alice(), NEAR, T0);
    r.set_record("1".into(), "description".into(), "x".into());
}

#[test]
#[should_panic(expected = "A record value can be at most 1 KB")]
fn record_values_are_bounded() {
    let mut r = setup();
    register(&mut r, &alice(), "desk", "runner.testnet", 3);
    call(&alice(), NEAR, T0);
    r.set_record("1".into(), "profile.description".into(), "x".repeat(1025));
}

// ---------------------------------------------------------------- owner and authorize (R1)

fn path_ids(path: &[PathNode]) -> Vec<String> {
    path.iter().map(|n| n.agent_id.clone()).collect()
}

#[test]
#[should_panic(expected = "Only the owner can initialize their registry")]
fn only_the_owner_initializes() {
    call(&bob(), 0, T0);
    Registry::new(alice());
}

#[test]
#[should_panic(expected = "Only the registry's owner can register agents")]
fn only_the_owner_registers_agents() {
    let mut r = setup();
    register(&mut r, &bob(), "bobs-agent", "runner.testnet", 3);
}

#[test]
fn the_owner_is_readable() {
    let r = setup();
    assert_eq!(r.get_owner(), alice());
}

#[test]
fn agents_without_an_executor_cannot_execute() {
    let mut r = setup();
    call(&alice(), NEAR, T0);
    let view = r.register_agent("trader".into(), None, caps(3), None, None, None);
    assert_eq!(view.executor, None);
    assert_eq!(
        exec_as(
            &mut r,
            &runner(),
            &alice(),
            "1",
            transfer("vendor.testnet", 1),
            1
        ),
        denied(Reason::ExecutorMismatch)
    );
}

#[test]
fn authorize_returns_the_path_to_the_owner() {
    let mut r = setup();
    call(&alice(), NEAR, T0);
    r.register_agent("desk".into(), None, caps(3), None, None, None);
    call(&alice(), NEAR, T0);
    r.create_child("1".into(), "bot-1".into(), None, caps(2), None, None, None);
    call(&alice(), 0, T0);
    match r.authorize("2".into(), transfer("vendor.testnet", 2), rid(1)) {
        Authorization::Allowed { path } => assert_eq!(path_ids(&path), vec!["1", "2"]),
        other => panic!("expected allowed, got {other:?}"),
    }
    assert_eq!(r.get_activity("2".into(), None)[0].outcome, "routed");
}

#[test]
fn authorize_refuses_other_callers_without_writing() {
    let mut r = setup();
    call(&alice(), NEAR, T0);
    r.register_agent("trader".into(), None, caps(3), None, None, None);
    call(&bob(), 0, T0);
    assert_eq!(
        r.authorize("1".into(), transfer("vendor.testnet", 1), rid(1)),
        Authorization::Denied {
            reason: Reason::UntrustedCaller,
            detail: None
        }
    );
    assert!(r.get_activity("1".into(), None).is_empty());
}

#[test]
fn authorize_applies_the_path_checks() {
    let mut r = setup();
    call(&alice(), NEAR, T0);
    r.register_agent("desk".into(), None, caps(3), None, None, None);
    call(&alice(), NEAR, T0);
    r.create_child("1".into(), "bot-1".into(), None, caps(3), None, None, None);
    call(&alice(), 0, T0);
    assert!(matches!(
        r.authorize("2".into(), transfer("vendor.testnet", 4), rid(1)),
        Authorization::Denied {
            reason: Reason::CapExceeded,
            ..
        }
    ));
    call(&alice(), 1, T0);
    r.pause("1".into());
    call(&alice(), 0, T0);
    assert!(matches!(
        r.authorize("2".into(), transfer("vendor.testnet", 1), rid(2)),
        Authorization::Denied {
            reason: Reason::BranchPaused,
            ..
        }
    ));
    assert_eq!(
        r.get_activity("2".into(), None)[0].reason,
        Some(Reason::BranchPaused)
    );
    assert!(matches!(
        r.authorize("2".into(), transfer("vendor.testnet", 1), "bad".into()),
        Authorization::Denied {
            reason: Reason::InvalidRequest,
            ..
        }
    ));
    assert!(matches!(
        r.authorize("9".into(), transfer("vendor.testnet", 1), rid(3)),
        Authorization::Denied {
            reason: Reason::AgentNotFound,
            ..
        }
    ));
}

#[test]
fn authorize_refuses_an_agent_the_owner_no_longer_holds() {
    let mut r = setup();
    call(&alice(), NEAR, T0);
    r.register_agent("trader".into(), None, caps(3), None, None, None);
    call(&alice(), 1, T0);
    r.nft_transfer(bob(), "1".into(), None, None);
    call(&alice(), 0, T0);
    assert!(matches!(
        r.authorize("1".into(), transfer("vendor.testnet", 1), rid(1)),
        Authorization::Denied {
            reason: Reason::PayerNotAuthorized,
            ..
        }
    ));
}
