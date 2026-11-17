// ABOUTME: relay-router codecs: the Hub routed withdrawal data, the bundle whose PDA
// ABOUTME: receives a routed withdrawal, and the router instruction data.

import { BorshCoder, Idl } from "@coral-xyz/anchor"
import { PublicKey, SystemProgram } from "@solana/web3.js"
import { sha256 } from "js-sha256"
import {
  decodeAbiParameters,
  encodeAbiParameters,
  Hex,
  parseAbiParameters,
} from "viem"

import { encodeBytes } from "../../../utils"
import { RelayRouterIdl } from "./idls/RelayRouterIdl"
import {
  encodeSolanaRoutedTransferRequest,
  ROUTED_TRANSFER_REQUEST_PREFIX,
  SolanaRoutedTransferRequest,
  toBytes32,
  toU64,
} from "./routed-transfer"

export const SOLANA_ROUTER_BUNDLE_VERSION = 1
export const SOLANA_NATIVE_MINT = "So11111111111111111111111111111111111111112"

const coder = new BorshCoder(RelayRouterIdl as Idl)

const toHex = (bytes: Uint8Array) => "0x" + Buffer.from(bytes).toString("hex")

const sha256Hex = (bytes: Uint8Array) =>
  "0x" + Buffer.from(sha256.create().update(bytes).array()).toString("hex")

// Hub routed withdrawal data

export const SOLANA_ROUTED_WITHDRAWAL_DATA_VERSION = 1

// Mirrors `SolanaRoutedWithdrawalData` in SolanaVmPayloadBuilder.sol (keys in base58)
export type SolanaRoutedWithdrawalData = {
  version: number
  router: string
  executor: string
}

const solanaRoutedWithdrawalDataAbiParams = parseAbiParameters([
  "(uint8 version, bytes32 router, bytes32 executor)",
])

export const encodeSolanaRoutedWithdrawalData = (
  data: SolanaRoutedWithdrawalData
): Hex => {
  if (data.version !== SOLANA_ROUTED_WITHDRAWAL_DATA_VERSION) {
    throw new Error("Unsupported routed withdrawal data version")
  }

  return encodeAbiParameters(solanaRoutedWithdrawalDataAbiParams, [
    {
      version: data.version,
      router: toHex(new PublicKey(data.router).toBytes()) as Hex,
      executor: toHex(new PublicKey(data.executor).toBytes()) as Hex,
    },
  ])
}

export const decodeSolanaRoutedWithdrawalData = (
  data: string
): SolanaRoutedWithdrawalData => {
  let result
  try {
    ;[result] = decodeAbiParameters(
      solanaRoutedWithdrawalDataAbiParams,
      data as Hex
    )
  } catch {
    throw new Error("Failed to decode routed withdrawal data")
  }

  if (result.version !== SOLANA_ROUTED_WITHDRAWAL_DATA_VERSION) {
    throw new Error("Unsupported routed withdrawal data version")
  }

  return {
    version: result.version,
    router: new PublicKey(toBytes32(result.router)).toBase58(),
    executor: new PublicKey(toBytes32(result.executor)).toBase58(),
  }
}

// Currency mapping shared by the oracle and the solver

const isNativeSolanaCurrency = (currency: string) =>
  currency === "" ||
  /^0x0*$/.test(currency) ||
  currency === SystemProgram.programId.toBase58()

const toSolanaPublicKey = (currency: string) =>
  currency.startsWith("0x")
    ? new PublicKey(toBytes32(currency)).toBase58()
    : new PublicKey(currency).toBase58()

// Zero currency is native SOL, which the bundle encodes as None
export const toSolanaBundleWithdrawMint = (currency: string): string | null =>
  isNativeSolanaCurrency(currency) ? null : toSolanaPublicKey(currency)

// The router pays native SOL when the fill mint is the native mint
export const toSolanaBundleFillMint = (currency: string): string =>
  isNativeSolanaCurrency(currency)
    ? SOLANA_NATIVE_MINT
    : toSolanaPublicKey(currency)

// Bundle calls (always empty while the router runs no user calls)

export type SolanaCallAccount = {
  pubkey: string
  isWritable: boolean
}

export type SolanaBundleCall = {
  programIdIndex: number
  accountIndexes: number[]
  data: string
}

const fromRawCallAccount = (account: {
  pubkey: PublicKey
  is_writable: boolean
}): SolanaCallAccount => ({
  pubkey: account.pubkey.toBase58(),
  isWritable: account.is_writable,
})

// Bundle

// Pubkeys in base58, amounts as decimal strings, ids as 0x-prefixed hex
export type SolanaRouterBundle = {
  version: number
  orderId: string
  executionId: string
  executor: string
  depository: string
  withdrawMint: string | null
  minimumWithdrawAmount: string
  fillMint: string
  recipient: string
  minimumAmount: string
  callAccounts: SolanaCallAccount[]
  calls: SolanaBundleCall[]
}

const toRawBundle = (bundle: SolanaRouterBundle) => {
  if (bundle.version !== SOLANA_ROUTER_BUNDLE_VERSION) {
    throw new Error("Unsupported router bundle version")
  }
  // The router rejects any bundle with calls (CallsNotSupported)
  if (bundle.calls.length || bundle.callAccounts.length) {
    throw new Error("Router bundle calls are not supported")
  }
  // The router only releases native SOL as None (InvalidMint)
  if (bundle.withdrawMint === SOLANA_NATIVE_MINT) {
    throw new Error("Router bundle withdraw mint cannot be the native mint")
  }

  return {
    version: bundle.version,
    order_id: toBytes32(bundle.orderId),
    execution_id: toBytes32(bundle.executionId),
    executor: new PublicKey(bundle.executor),
    depository: new PublicKey(bundle.depository),
    withdraw_mint:
      bundle.withdrawMint === null ? null : new PublicKey(bundle.withdrawMint),
    minimum_withdraw_amount: toU64(bundle.minimumWithdrawAmount),
    fill_mint: new PublicKey(bundle.fillMint),
    recipient: new PublicKey(bundle.recipient),
    minimum_amount: toU64(bundle.minimumAmount),
  }
}

export const encodeSolanaRouterBundle = (bundle: SolanaRouterBundle): Buffer =>
  coder.types.encode("Bundle", {
    ...toRawBundle(bundle),
    call_accounts: [],
    calls: [],
  })

export const decodeSolanaRouterBundle = (
  data: string | Uint8Array
): SolanaRouterBundle => {
  const buffer = Buffer.from(
    typeof data === "string" ? encodeBytes(data) : data
  )

  let bundle: SolanaRouterBundle
  try {
    const raw = coder.types.decode("Bundle", buffer)
    bundle = {
      version: raw.version,
      orderId: toHex(raw.order_id),
      executionId: toHex(raw.execution_id),
      executor: raw.executor.toBase58(),
      depository: raw.depository.toBase58(),
      withdrawMint: raw.withdraw_mint ? raw.withdraw_mint.toBase58() : null,
      minimumWithdrawAmount: raw.minimum_withdraw_amount.toString(),
      fillMint: raw.fill_mint.toBase58(),
      recipient: raw.recipient.toBase58(),
      minimumAmount: raw.minimum_amount.toString(),
      callAccounts: raw.call_accounts.map(fromRawCallAccount),
      calls: raw.calls.map(
        (call: {
          program_id_index: number
          account_indexes: Buffer
          data: Buffer
        }) => ({
          programIdIndex: call.program_id_index,
          accountIndexes: [...call.account_indexes],
          data: toHex(call.data),
        })
      ),
    }
  } catch {
    throw new Error("Failed to decode router bundle")
  }

  // The bundle hash commits to exact bytes, so trailing data is rejected
  if (!encodeSolanaRouterBundle(bundle).equals(buffer)) {
    throw new Error("Failed to decode router bundle")
  }

  return bundle
}

export const getSolanaRouterBundleHash = (bundle: SolanaRouterBundle): string =>
  sha256Hex(encodeSolanaRouterBundle(bundle))

export const getSolanaRouterBundlePda = (
  bundle: SolanaRouterBundle,
  routerProgramId: string
): { address: string; bump: number } => {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("bundle"), toBytes32(getSolanaRouterBundleHash(bundle))],
    new PublicKey(routerProgramId)
  )
  return { address: address.toBase58(), bump }
}

// The routed withdrawal receiver
export const getSolanaRouterBundleAddress = (
  bundle: SolanaRouterBundle,
  routerProgramId: string
): string => getSolanaRouterBundlePda(bundle, routerProgramId).address

// The PDA the depository requires as signer of execute_transfer_routed
export const getSolanaRouterAuthority = (routerProgramId: string): string =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("depository_caller")],
    new PublicKey(routerProgramId)
  )[0].toBase58()

// Holds the owner that grants depository roles
export const getSolanaRouterConfigAddress = (routerProgramId: string): string =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    new PublicKey(routerProgramId)
  )[0].toBase58()

// release only pays out of depositories whose role account exists
export const getSolanaRouterDepositoryRole = (
  routerProgramId: string,
  depositoryProgramId: string
): string =>
  PublicKey.findProgramAddressSync(
    [
      Buffer.from("depository_role"),
      new PublicKey(depositoryProgramId).toBuffer(),
    ],
    new PublicKey(routerProgramId)
  )[0].toBase58()

// Instruction data (discriminator ‖ borsh args); account order is in RelayRouterIdl

const getDiscriminator = (name: string) =>
  Buffer.from(
    RelayRouterIdl.instructions.find((ix) => ix.name === name)!.discriminator
  )

export const encodeSolanaRouterInitializeData = (args: {
  owner: string
}): Buffer =>
  Buffer.concat([
    getDiscriminator("initialize"),
    new PublicKey(args.owner).toBuffer(),
  ])

export const encodeSolanaRouterGrantDepositoryRoleData = (args: {
  depository: string
}): Buffer =>
  Buffer.concat([
    getDiscriminator("grant_depository_role"),
    new PublicKey(args.depository).toBuffer(),
  ])

export const encodeSolanaRouterRevokeDepositoryRoleData = (args: {
  depository: string
}): Buffer =>
  Buffer.concat([
    getDiscriminator("revoke_depository_role"),
    new PublicKey(args.depository).toBuffer(),
  ])

export const encodeSolanaRouterSetOwnerData = (args: {
  newOwner: string
}): Buffer =>
  Buffer.concat([
    getDiscriminator("set_owner"),
    new PublicKey(args.newOwner).toBuffer(),
  ])

export const encodeSolanaRouterReleaseData = (args: {
  bundleHash: string
  bump: number
  request: SolanaRoutedTransferRequest
}): Buffer =>
  Buffer.concat([
    getDiscriminator("release"),
    toBytes32(args.bundleHash),
    Buffer.from([args.bump]),
    // The request is borsh-encoded exactly as signed, minus the type prefix
    encodeSolanaRoutedTransferRequest(args.request).subarray(
      ROUTED_TRANSFER_REQUEST_PREFIX.length
    ),
  ])

export const encodeSolanaRouterSettleData = (args: {
  bundle: SolanaRouterBundle
  bump: number
}): Buffer =>
  Buffer.concat([
    getDiscriminator("settle"),
    encodeSolanaRouterBundle(args.bundle),
    Buffer.from([args.bump]),
  ])
