// ABOUTME: Addresses and test keys shared by the Circle Gateway fixture script and the gateway depository tests.
// ABOUTME: The fixtures are mainnet Circle Gateway programs and accounts, patched to trust the test keys below.

import { Keypair, PublicKey } from "@solana/web3.js"

export const GATEWAY_MINTER_PROGRAM = new PublicKey(
  "GATEm5SoBJiSw1v2Pz1iPBgUYkXzCUJ27XSXhDfSyzVZ"
)
export const GATEWAY_WALLET_PROGRAM = new PublicKey(
  "GATEwy4YxeiEbRJLwB6dXgg7q61e6zBPrMzYj5h1pRXQ"
)
export const USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
)

// Circle's domain id for Solana
export const SOLANA_DOMAIN = 5

const pda = (program: PublicKey, ...seeds: Buffer[]) =>
  PublicKey.findProgramAddressSync(seeds, program)[0]

export const GATEWAY_MINTER = pda(
  GATEWAY_MINTER_PROGRAM,
  Buffer.from("gateway_minter")
)
export const GATEWAY_MINTER_CUSTODY = pda(
  GATEWAY_MINTER_PROGRAM,
  Buffer.from("gateway_minter_custody"),
  USDC_MINT.toBuffer()
)
export const GATEWAY_MINTER_EVENT_AUTHORITY = pda(
  GATEWAY_MINTER_PROGRAM,
  Buffer.from("__event_authority")
)
export const usedTransferSpecHash = (transferSpecHash: Buffer) =>
  pda(
    GATEWAY_MINTER_PROGRAM,
    Buffer.from("used_transfer_spec_hash"),
    transferSpecHash
  )

export const GATEWAY_WALLET = pda(
  GATEWAY_WALLET_PROGRAM,
  Buffer.from("gateway_wallet")
)
export const GATEWAY_WALLET_CUSTODY = pda(
  GATEWAY_WALLET_PROGRAM,
  Buffer.from("gateway_wallet_custody"),
  USDC_MINT.toBuffer()
)
export const GATEWAY_WALLET_EVENT_AUTHORITY = pda(
  GATEWAY_WALLET_PROGRAM,
  Buffer.from("__event_authority")
)
export const gatewayDeposit = (depositor: PublicKey) =>
  pda(
    GATEWAY_WALLET_PROGRAM,
    Buffer.from("gateway_deposit"),
    USDC_MINT.toBuffer(),
    depositor.toBuffer()
  )
export const denylist = (account: PublicKey) =>
  pda(GATEWAY_WALLET_PROGRAM, Buffer.from("denylist"), account.toBuffer())

// Test-only secp256k1 key the fixture minter accepts attestations from
export const TEST_ATTESTER_PRIVATE_KEY = Buffer.from(
  "7b1f0c6e5d4a39281706f5e4d3c2b1a0918273645546372819a0b1c2d3e4f506",
  "hex"
)

// Test-only mint authority of the fixture USDC mint
export const TEST_MINT_AUTHORITY = Keypair.fromSeed(
  Buffer.from(
    "3c9d2e1f0a4b5c6d7e8f90112233445566778899aabbccddeeff001122334455",
    "hex"
  )
)
