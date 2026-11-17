// ABOUTME: LiteSVM harness for the relay gateway depository: builds one transfer or deposit case,
// ABOUTME: runs it against the compiled program and the Circle Gateway fixtures, and reports where funds went.

use std::path::PathBuf;

use base64::Engine;
use k256::ecdsa::SigningKey;
use litesvm::{types::TransactionResult, LiteSVM};
use sha2::{Digest, Sha256};
use sha3::Keccak256;
use solana_account::Account;
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;

pub const DEPOSITORY: Address =
    Address::from_str_const("DAt1pZmsCkKJ3WETGZPrtLhZq9inV3DrBSeZu12EKSe8");
pub const CALLER: Address = Address::from_str_const("3516fiQYXRSj3wmyaQ3UcxoQMxGpbFUCecDjCmaUZEp9");
pub const MINTER: Address = Address::from_str_const("GATEm5SoBJiSw1v2Pz1iPBgUYkXzCUJ27XSXhDfSyzVZ");
pub const WALLET: Address = Address::from_str_const("GATEwy4YxeiEbRJLwB6dXgg7q61e6zBPrMzYj5h1pRXQ");
pub const USDC: Address = Address::from_str_const("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
pub const TOKEN: Address = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const ATA_PROGRAM: Address =
    Address::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SYSTEM: Address = Address::from_str_const("11111111111111111111111111111111");
pub const IX_SYSVAR: Address =
    Address::from_str_const("Sysvar1nstructions1111111111111111111111111");
pub const ED25519: Address = Address::from_str_const("Ed25519SigVerify111111111111111111111111111");
pub const COMPUTE_BUDGET: Address =
    Address::from_str_const("ComputeBudget111111111111111111111111111111");

const PLAIN_PREFIX: &[u8] = b"RelayGatewayDepository:TransferRequest:v1";
const ROUTED_PREFIX: &[u8] = b"RelayGatewayDepository:RoutedTransferRequest:v1";
// Test keys the fixtures trust, see tests/fixtures/circle-gateway/constants.ts
const ATTESTER_KEY: &str = "7b1f0c6e5d4a39281706f5e4d3c2b1a0918273645546372819a0b1c2d3e4f506";
const MINT_AUTHORITY_SEED: &str =
    "3c9d2e1f0a4b5c6d7e8f90112233445566778899aabbccddeeff001122334455";
const SOL: u64 = 1_000_000_000;
const SLOT: u64 = 1_000;
/// The unix time of the fuzz clock
const NOW: i64 = 1_700_000_000;

//----------------------------------------
// Cases
//----------------------------------------

/// An account slot of `execute_transfer` / `execute_transfer_routed`
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TransferSlot {
    State,
    Recipient,
    Vault,
    Mint,
    RecipientToken,
    UsedRequest,
    IxSysvar,
    MinterProgram,
    MinterState,
    MinterCustody,
    UsedSpecHash,
    MinterEventAuthority,
    TokenProgram,
    SystemProgram,
}

/// An account slot of `deposit`
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum DepositSlot {
    State,
    Depositor,
    Mint,
    SenderToken,
    Vault,
    WalletProgram,
    WalletState,
    WalletCustody,
    GatewayDeposit,
    DepositoryDenylist,
    AllocatorDenylist,
    WalletEventAuthority,
    TokenProgram,
    SystemProgram,
}

/// The account put into a slot instead of the expected one
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Sub {
    Attacker,
    AttackerToken,
    AttackerUsedRequest,
    AttackerGatewayDeposit,
    AttackerDenylist,
    RecipientToken,
    State,
    Vault,
    Mint,
    MinterProgram,
    MinterState,
    MinterCustody,
    WalletProgram,
    WalletState,
    WalletCustody,
    CallerProgram,
    TokenProgram,
    SystemProgram,
}

/// A request field changed after the allocator signed
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Field {
    Domain,
    SpecHash,
    Recipient,
    Token,
    Amount,
    Nonce,
    Expiration,
    Router,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mutation {
    None,
    /// Another key signs the request
    WrongSigner,
    Tamper(Field),
    /// The request expired this many seconds before execution, 0 being the expiration itself
    Expired(i64),
    /// The allocator signed a request for another deployment's domain
    SignedDomain,
    /// The allocator signed a request for another token
    SignedToken,
    /// The accounts pay another recipient than the signed request's
    RedirectRecipient,
    /// Two signed requests in one transaction, each behind its own ed25519 instruction
    TwoRequests,
    /// Circle's attestation expired before execution
    AttestationExpired,
    /// Circle attested another amount than the request's
    AttestedAmount,
    /// Circle attested another destination caller than the vault
    AttestedCaller,
    /// Circle attested another recipient than the vault
    AttestedRecipient,
    /// A key Circle does not trust signed the attestation
    WrongAttester,
    /// The same transaction again
    Replay,
    /// A second request for an already minted transfer spec
    ReuseSpecHash,
    /// The allocator signed the other request type
    CrossKind,
    /// No ed25519 instruction in the transaction
    NoSignature,
    /// Another instruction sits between the ed25519 instruction and the transfer
    SignatureNotAdjacent,
    /// Two transfers in one transaction, both pointing at the first one's signature
    SharedSignature,
    /// Routed: the router reaches the depository through a nested call
    NestedRouter,
    /// Routed: the request names another router than the one signing
    WrongRouter,
    /// Routed: a top-level call without the router's signature
    DirectRouted,
    Transfer(TransferSlot, Sub),
    /// Deposit while deposits are disabled
    DepositsDisabled,
    Deposit(DepositSlot, Sub),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Plain,
    Routed,
    Deposit,
}

#[derive(Clone, Debug)]
pub struct Case {
    pub salt: u64,
    pub kind: Kind,
    pub amount: u64,
    /// USDC a third party sent to the vault beforehand
    pub vault_dust: u64,
    /// A third party funds the replay accounts with lamports beforehand
    pub prefund: bool,
    /// Seconds between execution and the request's expiration, at least 1
    pub lead: i64,
    pub mutation: Mutation,
}

#[derive(Clone, Debug, Default)]
pub struct Outcome {
    pub expect_success: bool,
    pub success: bool,
    pub compute_units: u64,
    pub logs: Vec<String>,
    /// Broken properties, empty when the case holds
    pub findings: Vec<String>,
}

//----------------------------------------
// Encoding
//----------------------------------------

pub fn sha(parts: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

fn keccak(parts: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Keccak256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

fn hex(value: &str) -> Vec<u8> {
    (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).unwrap())
        .collect()
}

fn discriminator(name: &str) -> [u8; 8] {
    sha(&[name.as_bytes()])[..8].try_into().unwrap()
}

pub fn keypair(salt: u64, label: &str) -> Keypair {
    Keypair::new_from_array(sha(&[&salt.to_le_bytes(), label.as_bytes()]))
}

fn pda(seeds: &[&[u8]], program: &Address) -> Address {
    Address::find_program_address(seeds, program).0
}

fn ata(owner: &Address) -> Address {
    pda(
        &[owner.as_ref(), TOKEN.as_ref(), USDC.as_ref()],
        &ATA_PROGRAM,
    )
}

fn state() -> Address {
    pda(&[b"relay_gateway_depository"], &DEPOSITORY)
}

fn vault() -> Address {
    pda(&[b"gateway_vault"], &DEPOSITORY)
}

fn domain() -> [u8; 32] {
    sha(&[
        b"RelayGatewayDepository",
        b"1",
        b"fuzz",
        DEPOSITORY.as_ref(),
    ])
}

#[derive(Clone, Copy)]
struct Request {
    domain: [u8; 32],
    transfer_spec_hash: [u8; 32],
    recipient: Address,
    token: Address,
    amount: u64,
    nonce: u64,
    expiration: i64,
    router: Option<Address>,
}

impl Request {
    fn encode(&self) -> Vec<u8> {
        let mut out = self.domain.to_vec();
        out.extend_from_slice(&self.transfer_spec_hash);
        out.extend_from_slice(self.recipient.as_ref());
        out.extend_from_slice(self.token.as_ref());
        out.extend_from_slice(&self.amount.to_le_bytes());
        out.extend_from_slice(&self.nonce.to_le_bytes());
        out.extend_from_slice(&self.expiration.to_le_bytes());
        if let Some(router) = self.router {
            out.extend_from_slice(router.as_ref());
        }
        out
    }

    fn hash(&self) -> [u8; 32] {
        let prefix = if self.router.is_some() {
            ROUTED_PREFIX
        } else {
            PLAIN_PREFIX
        };
        sha(&[prefix, &self.encode()])
    }

    fn used_request(&self) -> Address {
        pda(&[b"used_request", &self.hash()], &DEPOSITORY)
    }

    fn used_spec_hash(&self) -> Address {
        pda(
            &[b"used_transfer_spec_hash", &self.transfer_spec_hash],
            &MINTER,
        )
    }
}

/// Circle's signature over the single-element attestation its minter rebuilds
fn attest(
    signer: &[u8],
    caller: &Address,
    recipient: &Address,
    amount: u64,
    transfer_spec_hash: &[u8; 32],
    max_block_height: u64,
) -> [u8; 65] {
    let mut payload = hex("10cbb1ec");
    payload.extend_from_slice(&1u32.to_be_bytes());
    payload.extend_from_slice(&5u32.to_be_bytes());
    payload.extend_from_slice(MINTER.as_ref());
    payload.extend_from_slice(caller.as_ref());
    payload.extend_from_slice(&max_block_height.to_be_bytes());
    payload.extend_from_slice(&1u32.to_be_bytes());
    payload.extend_from_slice(USDC.as_ref());
    payload.extend_from_slice(recipient.as_ref());
    payload.extend_from_slice(&amount.to_be_bytes());
    payload.extend_from_slice(transfer_spec_hash);
    payload.extend_from_slice(&0u32.to_be_bytes());

    let digest = keccak(&[b"\x19Ethereum Signed Message:\n32", &keccak(&[&payload])]);
    let (signature, recovery) = SigningKey::from_slice(signer)
        .unwrap()
        .sign_prehash_recoverable(&digest)
        .unwrap();
    let mut out = [0u8; 65];
    out[..64].copy_from_slice(&signature.to_bytes());
    out[64] = 27 + recovery.to_byte();
    out
}

fn ed25519_instruction(signer: &Keypair, message: &[u8; 32]) -> Instruction {
    let signature = signer.sign_message(message);
    let mut data = vec![1, 0];
    for value in [48u16, u16::MAX, 16, u16::MAX, 112, 32, u16::MAX] {
        data.extend_from_slice(&value.to_le_bytes());
    }
    data.extend_from_slice(signer.pubkey().as_ref());
    data.extend_from_slice(signature.as_ref());
    data.extend_from_slice(message);
    Instruction {
        program_id: ED25519,
        accounts: vec![],
        data,
    }
}

fn compute_budget() -> Instruction {
    let mut data = vec![2];
    data.extend_from_slice(&1_000_000u32.to_le_bytes());
    Instruction {
        program_id: COMPUTE_BUDGET,
        accounts: vec![],
        data,
    }
}

fn system_transfer(from: &Address, to: &Address, lamports: u64) -> Instruction {
    let mut data = 2u32.to_le_bytes().to_vec();
    data.extend_from_slice(&lamports.to_le_bytes());
    Instruction {
        program_id: SYSTEM,
        accounts: vec![AccountMeta::new(*from, true), AccountMeta::new(*to, false)],
        data,
    }
}

fn create_ata(payer: &Address, owner: &Address) -> Instruction {
    Instruction {
        program_id: ATA_PROGRAM,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(ata(owner), false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(USDC, false),
            AccountMeta::new_readonly(SYSTEM, false),
            AccountMeta::new_readonly(TOKEN, false),
        ],
        // CreateIdempotent
        data: vec![1],
    }
}

fn mint_to(to: &Address, authority: &Address, amount: u64) -> Instruction {
    let mut data = vec![7];
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: TOKEN,
        accounts: vec![
            AccountMeta::new(USDC, false),
            AccountMeta::new(*to, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

/// The `execute_transfer` accounts in program order; the routed variant appends the router authority
fn transfer_metas(request: &Request, executor: &Address, recipient: &Address) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new_readonly(state(), false),
        AccountMeta::new(*executor, true),
        AccountMeta::new_readonly(*recipient, false),
        AccountMeta::new(vault(), false),
        AccountMeta::new_readonly(USDC, false),
        AccountMeta::new(ata(recipient), false),
        AccountMeta::new(request.used_request(), false),
        AccountMeta::new_readonly(IX_SYSVAR, false),
        AccountMeta::new_readonly(MINTER, false),
        AccountMeta::new_readonly(pda(&[b"gateway_minter"], &MINTER), false),
        AccountMeta::new(
            pda(&[b"gateway_minter_custody", USDC.as_ref()], &MINTER),
            false,
        ),
        AccountMeta::new(request.used_spec_hash(), false),
        AccountMeta::new_readonly(pda(&[b"__event_authority"], &MINTER), false),
        AccountMeta::new_readonly(TOKEN, false),
        AccountMeta::new_readonly(SYSTEM, false),
    ]
}

fn transfer_slot(slot: TransferSlot) -> usize {
    match slot {
        TransferSlot::State => 0,
        TransferSlot::Recipient => 2,
        TransferSlot::Vault => 3,
        TransferSlot::Mint => 4,
        TransferSlot::RecipientToken => 5,
        TransferSlot::UsedRequest => 6,
        TransferSlot::IxSysvar => 7,
        TransferSlot::MinterProgram => 8,
        TransferSlot::MinterState => 9,
        TransferSlot::MinterCustody => 10,
        TransferSlot::UsedSpecHash => 11,
        TransferSlot::MinterEventAuthority => 12,
        TransferSlot::TokenProgram => 13,
        TransferSlot::SystemProgram => 14,
    }
}

fn deposit_slot(slot: DepositSlot) -> usize {
    match slot {
        DepositSlot::State => 0,
        DepositSlot::Depositor => 2,
        DepositSlot::Mint => 3,
        DepositSlot::SenderToken => 4,
        DepositSlot::Vault => 5,
        DepositSlot::WalletProgram => 6,
        DepositSlot::WalletState => 7,
        DepositSlot::WalletCustody => 8,
        DepositSlot::GatewayDeposit => 9,
        DepositSlot::DepositoryDenylist => 10,
        DepositSlot::AllocatorDenylist => 11,
        DepositSlot::WalletEventAuthority => 12,
        DepositSlot::TokenProgram => 13,
        DepositSlot::SystemProgram => 14,
    }
}

fn transfer_instruction(
    request: &Request,
    metas: Vec<AccountMeta>,
    max_block_height: u64,
    circle_signature: &[u8; 65],
) -> Instruction {
    let name = if request.router.is_some() {
        "global:execute_transfer_routed"
    } else {
        "global:execute_transfer"
    };
    let mut data = discriminator(name).to_vec();
    data.extend_from_slice(&request.encode());
    data.extend_from_slice(&max_block_height.to_le_bytes());
    data.extend_from_slice(circle_signature);
    Instruction {
        program_id: DEPOSITORY,
        accounts: metas,
        data,
    }
}

/// Wraps a routed transfer in the router stand-in, `depth` program levels deep
fn through_caller(instruction: Instruction, depth: u8) -> Instruction {
    let authority = pda(&[b"depository_caller"], &CALLER);
    let mut accounts = vec![
        AccountMeta::new_readonly(CALLER, false),
        AccountMeta::new_readonly(DEPOSITORY, false),
    ];
    accounts.extend(instruction.accounts.into_iter().map(|mut meta| {
        if meta.pubkey == authority {
            meta.is_signer = false;
        }
        meta
    }));
    let mut data = vec![depth];
    data.extend_from_slice(&instruction.data);
    Instruction {
        program_id: CALLER,
        accounts,
        data,
    }
}

//----------------------------------------
// Environment
//----------------------------------------

fn manifest_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative)
}

fn program_path(env: &str, default: &str) -> PathBuf {
    std::env::var(env)
        .map(PathBuf::from)
        .unwrap_or_else(|_| manifest_path(default))
}

fn send(
    svm: &mut LiteSVM,
    instructions: &[Instruction],
    signers: &[&Keypair],
) -> TransactionResult {
    // The first signer pays; the others sign only when an instruction asks for them
    let required = |signer: &&Keypair| {
        instructions
            .iter()
            .flat_map(|instruction| &instruction.accounts)
            .any(|meta| meta.is_signer && meta.pubkey == signer.pubkey())
    };
    let mut signing = vec![signers[0]];
    signing.extend(signers[1..].iter().copied().filter(required));
    let transaction = Transaction::new_signed_with_payer(
        instructions,
        Some(&signers[0].pubkey()),
        &signing,
        svm.latest_blockhash(),
    );
    svm.send_transaction(transaction)
}

fn must_send(svm: &mut LiteSVM, instructions: &[Instruction], signers: &[&Keypair]) {
    if let Err(failed) = send(svm, instructions, signers) {
        panic!(
            "harness setup failed: {:?}\n{}",
            failed.err,
            failed.meta.logs.join("\n")
        );
    }
}

fn lamports(svm: &LiteSVM, address: &Address) -> u64 {
    svm.get_account(address)
        .map_or(0, |account| account.lamports)
}

fn tokens(svm: &LiteSVM, address: &Address) -> u64 {
    svm.get_account(address)
        .filter(|account| account.owner == TOKEN && account.data.len() >= 72)
        .map_or(0, |account| {
            u64::from_le_bytes(account.data[64..72].try_into().unwrap())
        })
}

/// Whether a program has created the account, as opposed to someone only funding the address
fn exists(svm: &LiteSVM, address: &Address) -> bool {
    svm.get_account(address)
        .is_some_and(|account| account.owner != SYSTEM)
}

/// Whether the oracle would read the request as executed: the depository's account, flagged used
fn marked_used(svm: &LiteSVM, request: &Request) -> bool {
    svm.get_account(&request.used_request())
        .is_some_and(|account| {
            account.owner == DEPOSITORY
                && account.data.len() == 9
                && account.data[..8] == discriminator("account:UsedRequest")
                && account.data[8] == 1
        })
}

/// The available balance of a Circle Gateway deposit account
fn gateway_balance(svm: &LiteSVM, depositor: &Address) -> u64 {
    svm.get_account(&gateway_deposit(depositor))
        .filter(|account| account.owner == WALLET && account.data.len() >= 75)
        .map_or(0, |account| {
            u64::from_le_bytes(account.data[67..75].try_into().unwrap())
        })
}

fn gateway_deposit(depositor: &Address) -> Address {
    pda(
        &[b"gateway_deposit", USDC.as_ref(), depositor.as_ref()],
        &WALLET,
    )
}

fn denylist(account: &Address) -> Address {
    pda(&[b"denylist", account.as_ref()], &WALLET)
}

fn give(svm: &mut LiteSVM, address: Address, lamports: u64) {
    let account = Account {
        lamports,
        data: vec![],
        owner: SYSTEM,
        executable: false,
        rent_epoch: 0,
    };
    svm.set_account(address, account).unwrap();
}

fn set_account(svm: &mut LiteSVM, address: Address, data: Vec<u8>, owner: Address) {
    let lamports = svm.minimum_balance_for_rent_exemption(data.len());
    svm.set_account(
        address,
        Account {
            lamports,
            data,
            owner,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

/// Loads an account file written by `yarn fetch:fixtures`
fn load_fixture(svm: &mut LiteSVM, name: &str) {
    let path = manifest_path("../tests/fixtures/circle-gateway").join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("{} missing, run `yarn fetch:fixtures`", path.display()));
    let json: serde_json::Value = serde_json::from_str(&text).unwrap();
    let account = &json["account"];
    let data = base64::engine::general_purpose::STANDARD
        .decode(account["data"][0].as_str().unwrap())
        .unwrap();
    svm.set_account(
        json["pubkey"].as_str().unwrap().parse().unwrap(),
        Account {
            lamports: account["lamports"].as_u64().unwrap(),
            data,
            owner: account["owner"].as_str().unwrap().parse().unwrap(),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn state_data(deposits_enabled: bool) -> Vec<u8> {
    let mut data = discriminator("account:RelayGatewayDepository").to_vec();
    data.extend_from_slice(keypair(0, "owner").pubkey().as_ref());
    data.extend_from_slice(keypair(0, "allocator").pubkey().as_ref());
    data.extend_from_slice(USDC.as_ref());
    data.extend_from_slice(MINTER.as_ref());
    data.extend_from_slice(WALLET.as_ref());
    data.push(deposits_enabled as u8);
    data.push(Address::find_program_address(&[b"relay_gateway_depository"], &DEPOSITORY).1);
    data.push(Address::find_program_address(&[b"gateway_vault"], &DEPOSITORY).1);
    data.extend_from_slice(&domain());
    data
}

/// The programs, the Circle Gateway fixtures and the depository state, cloned for every case
#[derive(Clone)]
pub struct Env {
    svm: LiteSVM,
}

impl Env {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new().with_precompiles();
        for (address, env, default) in [
            (
                DEPOSITORY,
                "DEPOSITORY_SO",
                "../target/deploy/relay_gateway_depository.so",
            ),
            (
                CALLER,
                "CALLER_SO",
                "../../depository-svm/tests/fixtures/routed-transfer-caller/target/deploy/routed_transfer_caller.so",
            ),
            (
                MINTER,
                "GATEWAY_MINTER_SO",
                "../tests/fixtures/circle-gateway/gateway_minter.so",
            ),
            (
                WALLET,
                "GATEWAY_WALLET_SO",
                "../tests/fixtures/circle-gateway/gateway_wallet.so",
            ),
        ] {
            let path = program_path(env, default);
            svm.add_program_from_file(address, &path)
                .unwrap_or_else(|_| panic!("{} missing, see the README", path.display()));
        }
        for fixture in [
            "gateway_minter.json",
            "gateway_minter_custody.json",
            "gateway_wallet.json",
            "gateway_wallet_custody.json",
            "usdc_mint.json",
        ] {
            load_fixture(&mut svm, fixture);
        }
        svm.warp_to_slot(SLOT);
        let mut clock: Clock = svm.get_sysvar();
        clock.unix_timestamp = NOW;
        svm.set_sysvar(&clock);

        set_account(&mut svm, state(), state_data(true), DEPOSITORY);
        // The vault token account, owned by the state account
        let mut vault_data = USDC.as_ref().to_vec();
        vault_data.extend_from_slice(state().as_ref());
        vault_data.resize(165, 0);
        vault_data[108] = 1;
        set_account(&mut svm, vault(), vault_data, TOKEN);

        Self { svm }
    }
}

impl Default for Env {
    fn default() -> Self {
        Self::new()
    }
}

struct Parties {
    executor: Keypair,
    recipient: Keypair,
    attacker: Keypair,
    allocator: Keypair,
    mint_authority: Keypair,
}

impl Parties {
    fn substitute(&self, sub: Sub) -> Address {
        match sub {
            Sub::Attacker => self.attacker.pubkey(),
            Sub::AttackerToken => ata(&self.attacker.pubkey()),
            Sub::AttackerUsedRequest => pda(
                &[b"used_request", self.attacker.pubkey().as_ref()],
                &DEPOSITORY,
            ),
            Sub::AttackerGatewayDeposit => gateway_deposit(&self.attacker.pubkey()),
            Sub::AttackerDenylist => denylist(&self.attacker.pubkey()),
            Sub::RecipientToken => ata(&self.recipient.pubkey()),
            Sub::State => state(),
            Sub::Vault => vault(),
            Sub::Mint => USDC,
            Sub::MinterProgram => MINTER,
            Sub::MinterState => pda(&[b"gateway_minter"], &MINTER),
            Sub::MinterCustody => pda(&[b"gateway_minter_custody", USDC.as_ref()], &MINTER),
            Sub::WalletProgram => WALLET,
            Sub::WalletState => pda(&[b"gateway_wallet"], &WALLET),
            Sub::WalletCustody => pda(&[b"gateway_wallet_custody", USDC.as_ref()], &WALLET),
            Sub::CallerProgram => CALLER,
            Sub::TokenProgram => TOKEN,
            Sub::SystemProgram => SYSTEM,
        }
    }
}

/// Balances every property is stated over
#[derive(Clone, Copy, Debug, PartialEq)]
struct Balances {
    recipient: u64,
    attacker: u64,
    vault: u64,
    minter_custody: u64,
    wallet_custody: u64,
    allocator_gateway: u64,
    attacker_gateway: u64,
    attacker_lamports: u64,
}

fn balances(svm: &LiteSVM, parties: &Parties) -> Balances {
    Balances {
        recipient: tokens(svm, &ata(&parties.recipient.pubkey())),
        attacker: tokens(svm, &ata(&parties.attacker.pubkey())),
        vault: tokens(svm, &vault()),
        minter_custody: tokens(svm, &parties.substitute(Sub::MinterCustody)),
        wallet_custody: tokens(svm, &parties.substitute(Sub::WalletCustody)),
        allocator_gateway: gateway_balance(svm, &parties.allocator.pubkey()),
        attacker_gateway: gateway_balance(svm, &parties.attacker.pubkey()),
        attacker_lamports: lamports(svm, &parties.attacker.pubkey()),
    }
}

//----------------------------------------
// Running a case
//----------------------------------------

pub fn run_case(env: &Env, case: &Case) -> Outcome {
    let mut svm = env.svm.clone();
    let parties = Parties {
        executor: keypair(case.salt, "executor"),
        recipient: keypair(case.salt, "recipient"),
        attacker: keypair(case.salt, "attacker"),
        allocator: keypair(0, "allocator"),
        mint_authority: Keypair::new_from_array(hex(MINT_AUTHORITY_SEED).try_into().unwrap()),
    };
    for party in [&parties.executor, &parties.recipient, &parties.attacker] {
        give(&mut svm, party.pubkey(), 100 * SOL);
    }
    give(&mut svm, parties.mint_authority.pubkey(), SOL);
    let executor = parties.executor.pubkey();
    must_send(
        &mut svm,
        &[
            create_ata(&executor, &parties.recipient.pubkey()),
            create_ata(&executor, &parties.attacker.pubkey()),
            mint_to(
                &ata(&parties.recipient.pubkey()),
                &parties.mint_authority.pubkey(),
                case.amount,
            ),
            mint_to(&vault(), &parties.mint_authority.pubkey(), case.vault_dust),
        ],
        &[&parties.executor, &parties.mint_authority],
    );

    if case.kind == Kind::Deposit {
        run_deposit(svm, case, &parties)
    } else {
        run_transfer(svm, case, &parties)
    }
}

fn run_transfer(mut svm: LiteSVM, case: &Case, parties: &Parties) -> Outcome {
    let routed = case.kind == Kind::Routed;
    let executor = parties.executor.pubkey();
    let recipient = parties.recipient.pubkey();
    let attacker = parties.attacker.pubkey();
    let caller_authority = pda(&[b"depository_caller"], &CALLER);

    let mut signed = Request {
        domain: domain(),
        transfer_spec_hash: sha(&[&case.salt.to_le_bytes(), b"spec"]),
        recipient,
        token: if case.mutation == Mutation::SignedToken {
            attacker
        } else {
            USDC
        },
        amount: case.amount,
        nonce: case.salt,
        expiration: match case.mutation {
            Mutation::Expired(past) => NOW - past,
            _ => NOW + case.lead,
        },
        router: routed.then_some(if case.mutation == Mutation::WrongRouter {
            attacker
        } else {
            CALLER
        }),
    };

    if case.mutation == Mutation::SignedDomain {
        signed.domain[0] ^= 1;
    }

    // What the executor submits; equal to what the allocator signed unless tampered with
    let mut submitted = signed;
    if let Mutation::Tamper(field) = case.mutation {
        match field {
            Field::Domain => submitted.domain[0] ^= 1,
            Field::SpecHash => submitted.transfer_spec_hash[0] ^= 1,
            Field::Recipient => submitted.recipient = attacker,
            Field::Token => submitted.token = attacker,
            Field::Amount => submitted.amount = submitted.amount.wrapping_add(1),
            Field::Nonce => submitted.nonce = submitted.nonce.wrapping_add(1),
            Field::Expiration => submitted.expiration += 1,
            Field::Router => submitted.router = submitted.router.map(|_| attacker),
        }
    }
    let tampered = submitted.encode() != signed.encode();
    let pays = if submitted.recipient == attacker || case.mutation == Mutation::RedirectRecipient {
        attacker
    } else {
        recipient
    };

    let signed_hash = if case.mutation == Mutation::CrossKind {
        Request {
            router: if routed { None } else { Some(CALLER) },
            ..signed
        }
        .hash()
    } else {
        signed.hash()
    };
    let signer = if case.mutation == Mutation::WrongSigner {
        &parties.attacker
    } else {
        &parties.allocator
    };

    let max_block_height = if case.mutation == Mutation::AttestationExpired {
        SLOT - 1
    } else {
        SLOT + 1_000
    };
    let attester = if case.mutation == Mutation::WrongAttester {
        sha(&[b"another attester"]).to_vec()
    } else {
        hex(ATTESTER_KEY)
    };
    let circle_signature = attest(
        &attester,
        &if case.mutation == Mutation::AttestedCaller {
            attacker
        } else {
            vault()
        },
        &if case.mutation == Mutation::AttestedRecipient {
            ata(&attacker)
        } else {
            vault()
        },
        if case.mutation == Mutation::AttestedAmount {
            submitted.amount.wrapping_add(1)
        } else {
            submitted.amount
        },
        &submitted.transfer_spec_hash,
        max_block_height,
    );

    let build = |request: &Request, signature: &[u8; 65]| {
        let mut metas = transfer_metas(request, &executor, &pays);
        let mut substituted = false;
        if let Mutation::Transfer(slot, sub) = case.mutation {
            let index = transfer_slot(slot);
            let address = parties.substitute(sub);
            substituted = metas[index].pubkey != address;
            metas[index].pubkey = address;
        }
        if routed {
            let direct = case.mutation == Mutation::DirectRouted;
            metas.push(AccountMeta {
                pubkey: caller_authority,
                is_signer: !direct,
                is_writable: false,
            });
            let instruction = transfer_instruction(request, metas, max_block_height, signature);
            let depth = if case.mutation == Mutation::NestedRouter {
                2
            } else {
                1
            };
            if direct {
                (instruction, substituted)
            } else {
                (through_caller(instruction, depth), substituted)
            }
        } else {
            (
                transfer_instruction(request, metas, max_block_height, signature),
                substituted,
            )
        }
    };
    let (transfer, substituted) = build(&submitted, &circle_signature);

    let mut instructions = vec![compute_budget()];
    if case.mutation != Mutation::NoSignature {
        instructions.push(ed25519_instruction(signer, &signed_hash));
    }
    if case.mutation == Mutation::SignatureNotAdjacent {
        instructions.push(system_transfer(&executor, &attacker, 1));
    }
    instructions.push(transfer);

    // A second request: riding on the first one's signature, or behind its own
    let mut second = None;
    if matches!(
        case.mutation,
        Mutation::SharedSignature | Mutation::TwoRequests
    ) {
        let other = Request {
            transfer_spec_hash: sha(&[&case.salt.to_le_bytes(), b"second spec"]),
            nonce: case.salt.wrapping_add(1),
            ..signed
        };
        if case.mutation == Mutation::TwoRequests {
            instructions.push(ed25519_instruction(&parties.allocator, &other.hash()));
        }
        let signature = attest(
            &hex(ATTESTER_KEY),
            &vault(),
            &vault(),
            other.amount,
            &other.transfer_spec_hash,
            max_block_height,
        );
        instructions.push(build(&other, &signature).0);
        second = Some(other);
    }

    let expect_success = match case.mutation {
        Mutation::None | Mutation::Replay | Mutation::ReuseSpecHash | Mutation::TwoRequests => true,
        Mutation::Transfer(..) => !substituted,
        Mutation::Tamper(_) => !tampered,
        _ => false,
    };

    if case.prefund {
        give(&mut svm, submitted.used_request(), SOL);
        give(&mut svm, submitted.used_spec_hash(), SOL);
    }

    let before = balances(&svm, parties);
    let result = send(&mut svm, &instructions, &[&parties.executor]);
    let mut outcome = Outcome {
        expect_success,
        success: result.is_ok(),
        ..Outcome::default()
    };
    match &result {
        Ok(meta) => {
            outcome.compute_units = meta.compute_units_consumed;
            outcome.logs = meta.logs.clone();
        }
        Err(failed) => outcome.logs = failed.meta.logs.clone(),
    }
    let after = balances(&svm, parties);
    let findings = &mut outcome.findings;

    if outcome.success != expect_success {
        findings.push(format!(
            "expected success = {expect_success}, got {}",
            outcome.success
        ));
    }
    let requests = if case.mutation == Mutation::TwoRequests {
        2
    } else {
        1
    };
    let paid = if outcome.success {
        requests * submitted.amount
    } else {
        0
    };
    let (to_recipient, to_attacker) = if pays == attacker {
        (0, paid)
    } else {
        (paid, 0)
    };
    if after.recipient != before.recipient + to_recipient {
        findings.push("recipient balance is not the signed amount".into());
    }
    if after.attacker != before.attacker + to_attacker || after.attacker_gateway != 0 {
        findings.push("a third party gained tokens".into());
    }
    if outcome.success && (tampered || pays != signed.recipient) {
        findings.push("a request the allocator did not sign executed".into());
    }
    if after.vault != before.vault {
        findings.push("the vault balance changed".into());
    }
    if before.minter_custody - after.minter_custody != paid {
        findings.push("Circle custody did not pay exactly the amount".into());
    }
    if after.attacker_lamports > before.attacker_lamports
        && case.mutation != Mutation::SignatureNotAdjacent
    {
        findings.push("a third party gained lamports".into());
    }
    if marked_used(&svm, &submitted) != outcome.success
        || exists(&svm, &submitted.used_request()) != outcome.success
    {
        findings.push("used_request does not match the outcome".into());
    }
    if exists(&svm, &submitted.used_spec_hash()) != outcome.success {
        findings.push("Circle's replay account does not match the outcome".into());
    }
    if let Some(other) = second {
        let signed_second = case.mutation == Mutation::TwoRequests && outcome.success;
        if marked_used(&svm, &other) != signed_second {
            findings.push("the second request does not match its signature".into());
        }
    }

    // A follow-up transaction that must never pay again
    let follow_up = match case.mutation {
        Mutation::Replay if outcome.success => Some(instructions.clone()),
        Mutation::ReuseSpecHash if outcome.success => {
            let again = Request {
                nonce: case.salt.wrapping_add(1),
                ..signed
            };
            let signature = attest(
                &hex(ATTESTER_KEY),
                &vault(),
                &vault(),
                again.amount,
                &again.transfer_spec_hash,
                max_block_height,
            );
            Some(vec![
                compute_budget(),
                ed25519_instruction(&parties.allocator, &again.hash()),
                build(&again, &signature).0,
            ])
        }
        _ => None,
    };
    if let Some(instructions) = follow_up {
        svm.expire_blockhash();
        let again = send(&mut svm, &instructions, &[&parties.executor]);
        if again.is_ok() || balances(&svm, parties) != after {
            findings.push("a replayed transfer paid again".into());
        }
    }

    outcome
}

fn run_deposit(mut svm: LiteSVM, case: &Case, parties: &Parties) -> Outcome {
    // The recipient plays the depositing user here
    let sender = parties.recipient.pubkey();
    let allocator = parties.allocator.pubkey();
    if case.mutation == Mutation::DepositsDisabled {
        set_account(&mut svm, state(), state_data(false), DEPOSITORY);
    }

    let mut metas = vec![
        AccountMeta::new_readonly(state(), false),
        AccountMeta::new(sender, true),
        AccountMeta::new_readonly(sender, false),
        AccountMeta::new_readonly(USDC, false),
        AccountMeta::new(ata(&sender), false),
        AccountMeta::new(vault(), false),
        AccountMeta::new_readonly(WALLET, false),
        AccountMeta::new_readonly(pda(&[b"gateway_wallet"], &WALLET), false),
        AccountMeta::new(
            pda(&[b"gateway_wallet_custody", USDC.as_ref()], &WALLET),
            false,
        ),
        AccountMeta::new(gateway_deposit(&allocator), false),
        AccountMeta::new_readonly(denylist(&state()), false),
        AccountMeta::new_readonly(denylist(&allocator), false),
        AccountMeta::new_readonly(pda(&[b"__event_authority"], &WALLET), false),
        AccountMeta::new_readonly(TOKEN, false),
        AccountMeta::new_readonly(SYSTEM, false),
    ];
    let mut substituted = false;
    if let Mutation::Deposit(slot, sub) = case.mutation {
        let index = deposit_slot(slot);
        let address = parties.substitute(sub);
        // The credited depositor is free to choose and not part of the funds flow
        substituted = metas[index].pubkey != address && slot != DepositSlot::Depositor;
        metas[index].pubkey = address;
    }
    let mut data = discriminator("global:deposit").to_vec();
    data.extend_from_slice(&case.amount.to_le_bytes());
    data.extend_from_slice(&sha(&[&case.salt.to_le_bytes(), b"deposit id"]));

    let expect_success = match case.mutation {
        Mutation::None => true,
        Mutation::Deposit(..) => !substituted,
        _ => false,
    };

    let before = balances(&svm, parties);
    let result = send(
        &mut svm,
        &[
            compute_budget(),
            Instruction {
                program_id: DEPOSITORY,
                accounts: metas,
                data,
            },
        ],
        &[&parties.recipient],
    );
    let mut outcome = Outcome {
        expect_success,
        success: result.is_ok(),
        ..Outcome::default()
    };
    match &result {
        Ok(meta) => {
            outcome.compute_units = meta.compute_units_consumed;
            outcome.logs = meta.logs.clone();
        }
        Err(failed) => outcome.logs = failed.meta.logs.clone(),
    }
    let after = balances(&svm, parties);
    let findings = &mut outcome.findings;

    if outcome.success != expect_success {
        findings.push(format!(
            "expected success = {expect_success}, got {}",
            outcome.success
        ));
    }
    let deposited = if outcome.success { case.amount } else { 0 };
    if before.recipient - after.recipient != deposited {
        findings.push("the sender did not pay exactly the amount".into());
    }
    if after.wallet_custody - before.wallet_custody != deposited {
        findings.push("Circle custody did not receive exactly the amount".into());
    }
    if after.allocator_gateway - before.allocator_gateway != deposited {
        findings.push("the allocator's Gateway balance did not grow by the amount".into());
    }
    if after.attacker != before.attacker || after.attacker_gateway != 0 {
        findings.push("a third party gained tokens".into());
    }
    if after.vault != before.vault {
        findings.push("the vault balance changed".into());
    }
    if after.minter_custody != before.minter_custody {
        findings.push("the minter custody changed on a deposit".into());
    }

    outcome
}
