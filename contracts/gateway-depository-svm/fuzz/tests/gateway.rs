// ABOUTME: Property test for the relay gateway depository, run in-process on LiteSVM.
// ABOUTME: `survey` runs generated transfer and deposit cases and fails on any broken property.

use std::collections::BTreeMap;

use proptest::{
    prelude::*,
    strategy::ValueTree,
    test_runner::{Config, RngAlgorithm, TestRng, TestRunner},
};
use relay_gateway_depository_fuzz::{
    run_case, Case, DepositSlot, Env, Field, Kind, Mutation, Sub, TransferSlot,
};

fn amount() -> impl Strategy<Value = u64> {
    prop_oneof![
        1 => 1..10u64,
        2 => 1..5_000_000u64,
        2 => 1..1_000_000_000_000u64,
    ]
}

fn dust() -> impl Strategy<Value = u64> {
    prop_oneof![
        3 => Just(0u64),
        1 => 1..3u64,
        1 => 1..2_000_000_000_000u64,
    ]
}

fn sub() -> impl Strategy<Value = Sub> {
    prop_oneof![
        Just(Sub::Attacker),
        Just(Sub::AttackerToken),
        Just(Sub::AttackerUsedRequest),
        Just(Sub::AttackerGatewayDeposit),
        Just(Sub::AttackerDenylist),
        Just(Sub::RecipientToken),
        Just(Sub::State),
        Just(Sub::Vault),
        Just(Sub::Mint),
        Just(Sub::MinterProgram),
        Just(Sub::MinterState),
        Just(Sub::MinterCustody),
        Just(Sub::WalletProgram),
        Just(Sub::WalletState),
        Just(Sub::WalletCustody),
        Just(Sub::CallerProgram),
        Just(Sub::TokenProgram),
        Just(Sub::SystemProgram),
    ]
}

fn transfer_slot() -> impl Strategy<Value = TransferSlot> {
    prop_oneof![
        Just(TransferSlot::State),
        Just(TransferSlot::Recipient),
        Just(TransferSlot::Vault),
        Just(TransferSlot::Mint),
        Just(TransferSlot::RecipientToken),
        Just(TransferSlot::UsedRequest),
        Just(TransferSlot::IxSysvar),
        Just(TransferSlot::MinterProgram),
        Just(TransferSlot::MinterState),
        Just(TransferSlot::MinterCustody),
        Just(TransferSlot::UsedSpecHash),
        Just(TransferSlot::MinterEventAuthority),
        Just(TransferSlot::TokenProgram),
        Just(TransferSlot::SystemProgram),
    ]
}

fn deposit_slot() -> impl Strategy<Value = DepositSlot> {
    prop_oneof![
        Just(DepositSlot::State),
        Just(DepositSlot::Depositor),
        Just(DepositSlot::Mint),
        Just(DepositSlot::SenderToken),
        Just(DepositSlot::Vault),
        Just(DepositSlot::WalletProgram),
        Just(DepositSlot::WalletState),
        Just(DepositSlot::WalletCustody),
        Just(DepositSlot::GatewayDeposit),
        Just(DepositSlot::DepositoryDenylist),
        Just(DepositSlot::AllocatorDenylist),
        Just(DepositSlot::WalletEventAuthority),
        Just(DepositSlot::TokenProgram),
        Just(DepositSlot::SystemProgram),
    ]
}

fn field() -> impl Strategy<Value = Field> {
    prop_oneof![
        Just(Field::Domain),
        Just(Field::SpecHash),
        Just(Field::Recipient),
        Just(Field::Token),
        Just(Field::Amount),
        Just(Field::Nonce),
        Just(Field::Expiration),
        Just(Field::Router),
    ]
}

fn transfer_mutation(routed: bool) -> BoxedStrategy<Mutation> {
    let common = prop_oneof![
        6 => Just(Mutation::None),
        1 => Just(Mutation::WrongSigner),
        4 => field().prop_map(Mutation::Tamper),
        2 => prop_oneof![Just(0i64), Just(1), 2..100_000_000i64].prop_map(Mutation::Expired),
        1 => Just(Mutation::SignedDomain),
        1 => Just(Mutation::SignedToken),
        2 => Just(Mutation::RedirectRecipient),
        2 => Just(Mutation::TwoRequests),
        1 => Just(Mutation::AttestationExpired),
        1 => Just(Mutation::AttestedAmount),
        1 => Just(Mutation::AttestedCaller),
        1 => Just(Mutation::AttestedRecipient),
        1 => Just(Mutation::WrongAttester),
        2 => Just(Mutation::Replay),
        2 => Just(Mutation::ReuseSpecHash),
        1 => Just(Mutation::CrossKind),
        1 => Just(Mutation::NoSignature),
        1 => Just(Mutation::SignatureNotAdjacent),
        2 => Just(Mutation::SharedSignature),
        10 => (transfer_slot(), sub()).prop_map(|(slot, sub)| Mutation::Transfer(slot, sub)),
    ];
    if routed {
        prop_oneof![
            10 => common,
            1 => Just(Mutation::NestedRouter),
            1 => Just(Mutation::WrongRouter),
            1 => Just(Mutation::DirectRouted),
        ]
        .boxed()
    } else {
        common.boxed()
    }
}

fn deposit_mutation() -> impl Strategy<Value = Mutation> {
    prop_oneof![
        3 => Just(Mutation::None),
        1 => Just(Mutation::DepositsDisabled),
        6 => (deposit_slot(), sub()).prop_map(|(slot, sub)| Mutation::Deposit(slot, sub)),
    ]
}

fn case() -> impl Strategy<Value = Case> {
    let kind = prop_oneof![
        3 => Just(Kind::Plain),
        3 => Just(Kind::Routed),
        2 => Just(Kind::Deposit),
    ];
    let lead = prop_oneof![Just(1i64), 2..100_000i64];
    (any::<u64>(), kind, amount(), dust(), any::<bool>(), lead).prop_flat_map(
        |(salt, kind, amount, vault_dust, prefund, lead)| {
            let mutation = match kind {
                Kind::Plain => transfer_mutation(false),
                Kind::Routed => transfer_mutation(true),
                Kind::Deposit => deposit_mutation().boxed(),
            };
            mutation.prop_map(move |mutation| Case {
                salt,
                kind,
                amount,
                vault_dust,
                prefund,
                lead,
                mutation,
            })
        },
    )
}

fn env_number(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn label(mutation: &Mutation) -> String {
    match mutation {
        Mutation::Transfer(slot, _) => format!("Transfer({slot:?})"),
        Mutation::Deposit(slot, _) => format!("Deposit({slot:?})"),
        Mutation::Expired(past) => format!("Expired({})", if *past == 0 { "at" } else { "past" }),
        other => format!("{other:?}"),
    }
}

#[test]
fn survey() {
    let cases = env_number("FUZZ_CASES", 2_000);
    let seed = env_number("FUZZ_SEED", 0);
    let only = std::env::var("FUZZ_INDEX")
        .ok()
        .and_then(|value| value.parse::<u64>().ok());

    let env = Env::new();
    let mut seed_bytes = [0u8; 32];
    seed_bytes[..8].copy_from_slice(&seed.to_le_bytes());
    let mut runner = TestRunner::new_with_rng(
        Config::default(),
        TestRng::from_seed(RngAlgorithm::ChaCha, &seed_bytes),
    );
    let strategy = case();

    // (kind, mutation) -> (succeeded, failed)
    let mut tally: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    let mut findings: BTreeMap<String, (u64, String)> = BTreeMap::new();
    let mut compute: BTreeMap<String, u64> = BTreeMap::new();
    // A replayed index past `FUZZ_CASES` still has to be generated to be reached
    let cases = only.map_or(cases, |only| cases.max(only + 1));
    for index in 0..cases {
        let case = strategy.new_tree(&mut runner).unwrap().current();
        if only.is_some_and(|only| only != index) {
            continue;
        }
        let outcome = run_case(&env, &case);
        if only.is_some() {
            println!("{case:?}\n{outcome:#?}");
        }
        let entry = tally
            .entry(format!("{:?} {}", case.kind, label(&case.mutation)))
            .or_default();
        if outcome.success {
            entry.0 += 1;
        } else {
            entry.1 += 1;
        }
        // Two requests in one transaction would double the figure
        if outcome.success && case.mutation != Mutation::TwoRequests {
            let units = compute.entry(format!("{:?}", case.kind)).or_default();
            *units = (*units).max(outcome.compute_units);
        }
        for finding in outcome.findings {
            findings
                .entry(finding)
                .or_insert((index, format!("{case:?}")));
        }
    }

    println!("{cases} cases, seed {seed}");
    for (name, (succeeded, failed)) in &tally {
        println!("  {name}: {succeeded} succeeded, {failed} failed");
    }
    for (kind, units) in &compute {
        println!("  max compute units, {kind}: {units}");
    }
    for (finding, (index, case)) in &findings {
        println!("FINDING {finding}\n  first at FUZZ_INDEX={index}: {case}");
    }
    assert!(findings.is_empty(), "{} broken properties", findings.len());
}
