// ABOUTME: Generates a security-council manifest that moves Hub balances still
// ABOUTME: held by the order addresses of given Relay requests to a recovery
// ABOUTME: account's Hub alias, one RelayHub transferFrom per funded order,
// ABOUTME: submitted through RelayMultisigSigner. Generic successor to the
// ABOUTME: one-off incident recovery generators.
//
// Use it when a deposit was credited on the Hub but never filled and the funds
// must not go back to the depositor (stolen funds, sanctioned sender, frozen
// fill). The operational procedure, including the approvals required before
// running it, lives in docs/fund-recovery-runbook.md.
//
// For each request id the script:
//   1. resolves the deposit through the public Relay API, and maps the API
//      chain id to the protocol chain id through the public chains API,
//   2. reads the deposit's block timestamp from the origin chain for EVM
//      deposits (the legacy order-address derivation hashes the block time,
//      not the API's indexing time) and uses the API timestamp otherwise,
//   3. probes every known order-address derivation (current and legacy, each
//      chain-id string, order id and onchain id) against the Hub balances,
//   4. falls back to scanning the Hub mint events after the deposit for an
//      exact-amount mint when no derivation is funded. A mint match is not tied
//      to the request, so it is only used when the operator names it with
//      --mint-source,
//   5. refuses to continue unless exactly one funded account is found,
//   6. merges requests credited to the same account and token into one
//      transfer capped at their combined deposits.
//
// The receiver is the recovery account's Hub alias derived with the same
// chain-id string as the funds' token id, so the recovery account can withdraw
// the balance on the deposit chain in the deposited currency. The recovery
// account must therefore be an address of the deposit chain's VM that the
// recovery signers control on that chain.
//
// All RPC operations are read-only. The script never signs or broadcasts.
import { Command } from "commander"
import { unlinkSync, writeFileSync } from "fs"
import {
  createPublicClient,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseAbi,
  parseAbiItem,
  zeroAddress,
} from "viem"
import { RelayHub } from "@relay-protocol/settlement-abis"
import {
  encodeAddressToHex,
  generateAddress,
  generateTokenId,
  getOrderAddress,
  type VmType,
} from "@relay-protocol/settlement-sdk"
import { networks } from "@relay-protocol/settlement-networks"
import * as tronweb from "tronweb"
import { getLegacyOrderAddress } from "./helpers/legacyOrderAddress"
import { stringifyJsonWithBigInt } from "./helpers/manifest"

export const DEFAULT_RELAY_API_URL = "https://api.relay.link"
export const DEFAULT_MINT_SCAN_HOURS = 6
// Non-EVM timestamps come from the API's indexing time, which trails the
// block time, so the mint scan starts this much earlier.
const API_TIMESTAMP_SLACK_SECONDS = 600n
const LOG_CHUNK_BLOCKS = 10_000n
const EVM_NATIVE_DECIMALS = 18
const API_TIMEOUT_MS = 30_000

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address caller, address indexed from, address indexed to, uint256 indexed id, uint256 amount)"
)
const ALLOCATOR_ABI = parseAbi([
  "function payloadBuilders(string chainId, bytes depository) view returns (address)",
])
const ALLOCATOR_ADDRESS = getAddress(
  "0x613D3c588F6B8f89302b463F8F19f7241B2857E2"
)
const ERC20_DECIMALS_ABI = parseAbi([
  "function decimals() view returns (uint8)",
])

type Hex = `0x${string}`

// VMs whose recovery-account addresses this script can validate.
export const SUPPORTED_FAMILIES = [
  "ethereum-vm",
  "solana-vm",
  "tron-vm",
] as const satisfies readonly VmType[]
export type SupportedFamily = (typeof SUPPORTED_FAMILIES)[number]

export type RecoveryDeposit = {
  requestId: string
  status?: string
  orderId: Hex
  onchainId?: Hex
  family: SupportedFamily
  // Chain id the Relay API uses, and the protocol chain id the oracle uses.
  apiChainId: number
  protocolChainId: string
  depositor: string
  currency: string
  symbol?: string
  amount: bigint
  decimals: number
  transactionId: string
  timestamp: bigint
  // True when the timestamp is the API's indexing time, not the block time.
  timestampApproximate: boolean
  // True when neither the API nor the chain gave the decimals; amounts are
  // then shown in base units.
  decimalsUnknown?: boolean
}

export type RecoverySource = {
  // Several requests share a source when they credited the same account and
  // token; `depositedAmount` is then their combined deposits.
  requests: { requestId: string; depositedAmount: bigint }[]
  account: Hex
  label: string
  tokenId: bigint
  chainIdString: string
  amount: bigint
  depositedAmount: bigint
  decimals: number
  currency: string
  symbol?: string
  protocolChainId: string
  receiver: Hex
}

export type RecoveryTransaction = {
  amount: "0"
  calldata: Hex
  family: "ethereum-vm"
  from: Hex
  gas: string
  maxFeePerGas: string
  maxPriorityFeePerGas: string
  nonce: number
  rpc: string
  to: string
}

export type RecoveryPlan = {
  receiver: string
  signer: Hex
  sources: RecoverySource[]
  transactions: RecoveryTransaction[]
  warnings: string[]
}

// Minimal client surfaces the planner needs, so tests can supply fakes.
export type HubClient = {
  readContract: (_args: {
    abi: typeof RelayHub
    address: Hex
    args: readonly [Hex, bigint]
    functionName: "balanceOf"
  }) => Promise<unknown>
  estimateGas: (_args: { account: Hex; data: Hex; to: Hex }) => Promise<bigint>
  getTransactionCount: (_args: { address: Hex }) => Promise<number>
  getBlock: (_args?: { blockNumber: bigint }) => Promise<{
    number: bigint
    timestamp: bigint
  }>
  getLogs: (_args: {
    address: Hex
    args: { from: Hex; id?: bigint[] }
    event: typeof TRANSFER_EVENT
    fromBlock: bigint
    toBlock: bigint
  }) => Promise<{ args: { to?: Hex; id?: bigint; amount?: bigint } }[]>
}

export type EvmOriginClient = {
  getTransactionReceipt: (_args: { hash: Hex }) => Promise<{
    blockNumber: bigint
  }>
  getBlock: (_args: { blockNumber: bigint }) => Promise<{ timestamp: bigint }>
  readContract: (_args: {
    abi: typeof ERC20_DECIMALS_ABI
    address: Hex
    functionName: "decimals"
  }) => Promise<unknown>
}

export type RecoveryDependencies = {
  fetchJson: (_url: string) => Promise<unknown>
  hubAddress: Hex
  hubClient: HubClient
  hubRpcUrl: string
  gasConfig: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
  evmOriginClientFor: (_protocolChainId: string) => EvmOriginClient
  signerAddress: Hex
  // RelayAllocator.payloadBuilders: an owner withdrawal reverts unless a
  // builder is registered for the chain-id string and depository.
  payloadBuilderOf: (_chainIdString: string, _depository: Hex) => Promise<Hex>
  // v3 requires an API key; v2 is public but retires on 2026-11-24.
  requestsApiVersion?: "v2" | "v3"
  log?: (_message: string) => void
}

export type RecoveryOptions = {
  requestIds: string[]
  receiver: string
  expectedTotal?: bigint
  apiUrl?: string
  mintScanHours?: number
  // Hub account the operator confirmed for a request whose funds were only
  // found through the mint-event fallback, keyed by request id.
  mintSources?: Record<string, string>
}

const isSupportedFamily = (family: unknown): family is SupportedFamily =>
  SUPPORTED_FAMILIES.includes(family as SupportedFamily)

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/

/// Validates a recovery-account address for a VM and returns it normalized
/// (EVM checksummed; other VMs are case-sensitive and kept as given).
export const normalizeReceiver = (
  receiver: string,
  family: SupportedFamily
) => {
  const value = receiver.trim()
  switch (family) {
    case "ethereum-vm":
      if (!isAddress(value)) break
      return getAddress(value)
    case "solana-vm":
      if (!BASE58.test(value)) break
      try {
        encodeAddressToHex(value, family)
      } catch {
        break
      }
      return value
    case "tron-vm":
      if (!/^T/.test(value) || !BASE58.test(value) || value.length !== 34) break
      if (!tronweb.utils.address.isAddress(value)) break
      return value
  }
  throw new Error(`Invalid ${family} receiver address ${receiver}`)
}

/// Compares the encoded bytes, so every textual form of an address matches
/// (EVM casing, Tron base58 and hex). Unparseable input compares as text.
export const sameAddress = (a: string, b: string, family: SupportedFamily) => {
  try {
    return encodeAddressToHex(a, family) === encodeAddressToHex(b, family)
  } catch {
    return a === b
  }
}

const HEX_ID = /^(0x)?[0-9a-fA-F]+$/

/// Hex transaction ids compare case-insensitively and with or without 0x;
/// base58 ids such as Solana signatures compare exactly.
const sameTransactionId = (a: string, b: string) =>
  HEX_ID.test(a) && HEX_ID.test(b)
    ? a.replace(/^0x/, "").toLowerCase() === b.replace(/^0x/, "").toLowerCase()
    : a === b

/// Every chain-id string the oracle may have used for a deposit chain in token
/// ids and order addresses: the protocol chain id first, then the network's
/// slug, Hub chain id and numeric id, and the API's numeric id.
export const chainIdStrings = (
  deposit: Pick<RecoveryDeposit, "apiChainId" | "protocolChainId">
): string[] => {
  const network = networks[deposit.protocolChainId]
  return [
    ...new Set(
      [
        deposit.protocolChainId,
        network?.slug,
        network?.hubChainId,
        network ? String(network.chainId) : undefined,
        String(deposit.apiChainId),
      ].filter((value): value is string => Boolean(value))
    ),
  ]
}

/// Candidate Hub accounts the oracle may have credited for a deposit. The
/// exact derivation is recovered by probing them against the Hub balances.
export const orderAddressCandidates = (deposit: RecoveryDeposit) => {
  const depositIds = [
    { depositId: deposit.orderId, idLabel: "orderId" },
    ...(deposit.onchainId && deposit.onchainId !== deposit.orderId
      ? [{ depositId: deposit.onchainId, idLabel: "onchainId" }]
      : []),
  ]

  const candidates: {
    address: Hex
    chainIdString: string
    label: string
    tokenId: bigint
  }[] = []
  for (const chainIdString of chainIdStrings(deposit)) {
    const tokenId = generateTokenId({
      address: deposit.currency,
      chainId: chainIdString,
      family: deposit.family,
    })
    for (const { depositId, idLabel } of depositIds) {
      const derivations: [string, string][] = [
        [
          "orderAddress",
          getOrderAddress({ chainId: chainIdString, depositId }),
        ],
        [
          "legacyOrderAddress",
          getLegacyOrderAddress({
            chainId: chainIdString,
            depositId,
            depositor: deposit.depositor,
            timestamp: deposit.timestamp,
            vmType: deposit.family,
          }),
        ],
      ]
      for (const [fnLabel, address] of derivations) {
        candidates.push({
          address: getAddress(address) as Hex,
          chainIdString,
          label: `${fnLabel}(${chainIdString}, ${idLabel})`,
          tokenId,
        })
      }
    }
  }
  return candidates
}

/// The chain-id string whose token id for the deposit currency is `tokenId`.
export const chainIdStringForTokenId = (
  deposit: Pick<
    RecoveryDeposit,
    "apiChainId" | "currency" | "family" | "protocolChainId"
  >,
  tokenId: bigint
) => {
  for (const chainIdString of chainIdStrings(deposit)) {
    const candidate = generateTokenId({
      address: deposit.currency,
      chainId: chainIdString,
      family: deposit.family,
    })
    if (candidate === tokenId) return chainIdString
  }
  throw new Error(
    `Token id ${tokenId} does not match any known chain-id string for ${deposit.protocolChainId}; derive the receiver alias manually`
  )
}

/// The recovery account's Hub alias for the chain-id string backing the funds'
/// token id, so its withdraw requests resolve to the alias holding the balance.
export const receiverAlias = (
  receiver: string,
  chainIdString: string,
  family: SupportedFamily
) =>
  getAddress(
    generateAddress({ address: receiver, chainId: chainIdString, family })
  ) as Hex

/// Merges sources credited to the same account and token, then caps each
/// transfer at the combined deposits of its requests: an account holding more
/// needs a manual decision. Sources come in with `amount` set to the balance.
const mergeSources = (sources: RecoverySource[]) => {
  const merged = new Map<string, RecoverySource>()
  const warnings: string[] = []
  for (const source of sources) {
    const key = `${source.account.toLowerCase()}-${source.tokenId}`
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, { ...source, requests: [...source.requests] })
      continue
    }
    existing.requests.push(...source.requests)
    existing.depositedAmount += source.depositedAmount
    existing.amount = source.amount
  }

  for (const source of merged.values()) {
    const ids = source.requests.map(({ requestId }) => requestId).join(", ")
    const format = (value: bigint) => formatUnits(value, source.decimals)
    if (source.requests.length > 1) {
      warnings.push(
        `${source.account} (id ${source.tokenId}) holds the funds of ${ids}; one transfer covers their combined deposits`
      )
    }
    if (source.amount > source.depositedAmount) {
      warnings.push(
        `${ids}: Hub balance ${format(source.amount)} exceeds the deposit ${format(source.depositedAmount)}; only the deposited amount is transferred`
      )
      source.amount = source.depositedAmount
    } else if (source.amount < source.depositedAmount) {
      warnings.push(
        `${ids}: Hub balance ${format(source.amount)} is below the deposit ${format(source.depositedAmount)}; part of the funds has already moved`
      )
    }
  }
  return { sources: [...merged.values()], warnings }
}

type RelayRequestsResponse = {
  requests?: {
    status?: string
    protocol?: {
      orderId?: Hex
      deposit?: {
        origin?: {
          amount: string
          chainId: number
          currency: string
          depositor: string
          onchainId?: Hex
          transactionId: string
        }
      }
    }
    data?: {
      // v2 names the hash `hash`, v3 `txHash`.
      inTxs?: { hash?: string; txHash?: string; timestamp?: number }[]
      // v2 only.
      metadata?: { currencyIn?: { currency?: ApiCurrency } }
      // v3 only.
      route?: {
        actual?: { origin?: { inputCurrency?: { currency?: ApiCurrency } } }
        quoted?: { origin?: { inputCurrency?: { currency?: ApiCurrency } } }
      }
    }
  }[]
}

type ApiCurrency = {
  address?: string
  chainId?: number
  decimals?: number
  symbol?: string
}

type RelayChainsResponse = {
  chains?: { id: number; protocol?: { v2?: { chainId?: string } } }[]
}

/// The protocol chain id the oracle uses for each Relay API chain id, read once
/// per run because the public endpoint is rate limited.
const fetchProtocolChainIds = async (
  deps: Pick<RecoveryDependencies, "fetchJson">,
  apiUrl: string
) => {
  const body = (await deps.fetchJson(`${apiUrl}/chains`)) as RelayChainsResponse
  const protocolChainIds = new Map<number, string>()
  for (const chain of body.chains ?? []) {
    const protocolChainId = chain.protocol?.v2?.chainId
    if (protocolChainId) protocolChainIds.set(chain.id, protocolChainId)
  }
  return protocolChainIds
}

const fetchDeposit = async (
  requestId: string,
  deps: Pick<
    RecoveryDependencies,
    "fetchJson" | "evmOriginClientFor" | "requestsApiVersion"
  >,
  protocolChainIds: Map<number, string>,
  apiUrl: string
): Promise<RecoveryDeposit> => {
  const version = deps.requestsApiVersion ?? "v2"
  const body = (await deps.fetchJson(
    `${apiUrl}/requests/${version}?id=${encodeURIComponent(requestId)}`
  )) as RelayRequestsResponse
  const request = body.requests?.[0]
  const origin = request?.protocol?.deposit?.origin
  const orderId = request?.protocol?.orderId
  if (!request || !origin || !orderId) {
    throw new Error(`Relay API returned no deposit data for ${requestId}`)
  }

  const protocolChainId = protocolChainIds.get(origin.chainId)
  if (!protocolChainId) {
    throw new Error(
      `No protocol chain id published for API chain ${origin.chainId}`
    )
  }
  const family = networks[protocolChainId]?.family
  if (!isSupportedFamily(family)) {
    throw new Error(
      `Request ${requestId} was deposited on ${protocolChainId} (${family ?? "unknown family"}); supported: ${SUPPORTED_FAMILIES.join(", ")}`
    )
  }

  const apiCurrency =
    request.data?.metadata?.currencyIn?.currency ??
    request.data?.route?.actual?.origin?.inputCurrency?.currency ??
    request.data?.route?.quoted?.origin?.inputCurrency?.currency
  // Decimals only affect displayed amounts. The input currency is the
  // deposited one; when the API includes its address, it must match too.
  const matchingApiCurrency =
    apiCurrency?.chainId === origin.chainId &&
    (apiCurrency.address === undefined ||
      sameAddress(apiCurrency.address, origin.currency, family))
      ? apiCurrency
      : undefined
  const apiDecimals = matchingApiCurrency?.decimals
  const apiTimestamp = request.data?.inTxs?.find((tx) =>
    sameTransactionId(tx.txHash ?? tx.hash ?? "", origin.transactionId)
  )?.timestamp

  let timestamp: bigint
  let timestampApproximate = false
  let decimals = apiDecimals
  if (family === "ethereum-vm") {
    // The legacy derivation hashes the block time: read it from the chain.
    const client = deps.evmOriginClientFor(protocolChainId)
    const receipt = await client.getTransactionReceipt({
      hash: origin.transactionId as Hex,
    })
    timestamp = (await client.getBlock({ blockNumber: receipt.blockNumber }))
      .timestamp
    if (decimals === undefined) {
      decimals =
        origin.currency.toLowerCase() === zeroAddress
          ? (networks[protocolChainId]?.nativeCurrency?.decimals ??
            EVM_NATIVE_DECIMALS)
          : Number(
              await client.readContract({
                abi: ERC20_DECIMALS_ABI,
                address: origin.currency as Hex,
                functionName: "decimals",
              })
            )
    }
  } else {
    if (apiTimestamp === undefined) {
      throw new Error(
        `Relay API returned no deposit timestamp for ${requestId}`
      )
    }
    timestamp = BigInt(apiTimestamp)
    timestampApproximate = true
  }

  return {
    amount: BigInt(origin.amount),
    apiChainId: origin.chainId,
    currency:
      family === "ethereum-vm" ? getAddress(origin.currency) : origin.currency,
    decimals: decimals ?? 0,
    decimalsUnknown: decimals === undefined,
    depositor:
      family === "ethereum-vm"
        ? getAddress(origin.depositor)
        : origin.depositor,
    family,
    onchainId: origin.onchainId,
    orderId,
    protocolChainId,
    requestId,
    status: request.status,
    symbol: matchingApiCurrency?.symbol,
    timestamp,
    timestampApproximate,
    transactionId: origin.transactionId,
  }
}

const hubBalance = async (
  deps: RecoveryDependencies,
  account: Hex,
  tokenId: bigint
) =>
  (await deps.hubClient.readContract({
    abi: RelayHub,
    address: deps.hubAddress,
    args: [account, tokenId],
    functionName: "balanceOf",
  })) as bigint

// Smallest Hub block with a timestamp at or after `target` (binary search).
const findBlockByTimestamp = async (client: HubClient, target: bigint) => {
  const latest = await client.getBlock()
  if (latest.timestamp <= target) return latest.number
  let low = 1n
  let high = latest.number
  while (low < high) {
    const mid = (low + high) / 2n
    const block = await client.getBlock({ blockNumber: mid })
    if (block.timestamp < target) {
      low = mid + 1n
    } else {
      high = mid
    }
  }
  return low
}

// getLogs over a block range, halving the chunk whenever the RPC rejects a
// range as too large.
const getMintLogs = async (
  deps: RecoveryDependencies,
  fromBlock: bigint,
  toBlock: bigint,
  tokenIds: bigint[]
) => {
  const logs: Awaited<ReturnType<HubClient["getLogs"]>> = []
  let start = fromBlock
  let span = LOG_CHUNK_BLOCKS
  while (start <= toBlock) {
    const end = start + span - 1n > toBlock ? toBlock : start + span - 1n
    try {
      logs.push(
        ...(await deps.hubClient.getLogs({
          address: deps.hubAddress,
          args: { from: zeroAddress, id: tokenIds },
          event: TRANSFER_EVENT,
          fromBlock: start,
          toBlock: end,
        }))
      )
      start = end + 1n
    } catch (error) {
      const message = (error as Error).message ?? ""
      if (span > 50n && /exceeds|limit|too large|-32005/i.test(message)) {
        span /= 2n
        continue
      }
      throw error
    }
  }
  return logs
}

// Fallback when no derivation is funded: the Hub mint events in the window
// after the deposit whose amount and token id match the deposit exactly.
const findMintsByAmount = async (
  deps: RecoveryDependencies,
  deposit: RecoveryDeposit,
  scanHours: number
) => {
  const start = deposit.timestampApproximate
    ? deposit.timestamp - API_TIMESTAMP_SLACK_SECONDS
    : deposit.timestamp
  const fromBlock = await findBlockByTimestamp(deps.hubClient, start)
  const toBlock = await findBlockByTimestamp(
    deps.hubClient,
    deposit.timestamp + BigInt(Math.round(scanHours * 3600))
  )
  const tokenIds = chainIdStrings(deposit).map((chainIdString) =>
    generateTokenId({
      address: deposit.currency,
      chainId: chainIdString,
      family: deposit.family,
    })
  )

  const matches = new Map<string, { account: Hex; tokenId: bigint }>()
  for (const log of await getMintLogs(deps, fromBlock, toBlock, tokenIds)) {
    const { to, id, amount } = log.args
    if (!to || id === undefined || amount !== deposit.amount) continue
    matches.set(`${to.toLowerCase()}-${id}`, { account: to, tokenId: id })
  }
  return [...matches.values()]
}

const locateSource = async (
  deps: RecoveryDependencies,
  deposit: RecoveryDeposit,
  receiver: string,
  scanHours: number,
  mintSource: string | undefined,
  warnings: string[]
): Promise<RecoverySource> => {
  const log = deps.log ?? (() => undefined)
  const format = (value: bigint) => formatUnits(value, deposit.decimals)

  const funded: RecoverySource[] = []
  const toSource = (
    account: Hex,
    label: string,
    tokenId: bigint,
    balance: bigint
  ): RecoverySource => {
    const chainIdString = chainIdStringForTokenId(deposit, tokenId)
    return {
      account,
      amount: balance,
      chainIdString,
      currency: deposit.currency,
      decimals: deposit.decimals,
      depositedAmount: deposit.amount,
      label,
      protocolChainId: deposit.protocolChainId,
      receiver: receiverAlias(receiver, chainIdString, deposit.family),
      requests: [
        { depositedAmount: deposit.amount, requestId: deposit.requestId },
      ],
      symbol: deposit.symbol,
      tokenId,
    }
  }

  for (const candidate of orderAddressCandidates(deposit)) {
    const balance = await hubBalance(deps, candidate.address, candidate.tokenId)
    if (balance === 0n) continue
    log(
      `  found ${candidate.label} -> ${candidate.address} | balance ${format(balance)}`
    )
    funded.push(
      toSource(candidate.address, candidate.label, candidate.tokenId, balance)
    )
  }

  if (funded.length > 0 && mintSource !== undefined) {
    throw new Error(
      `--mint-source was given for ${deposit.requestId}, but its order address is funded; drop it`
    )
  }

  if (funded.length === 0) {
    log("  no derived order address is funded, scanning Hub mint events")
    const matches: RecoverySource[] = []
    for (const match of await findMintsByAmount(deps, deposit, scanHours)) {
      const balance = await hubBalance(deps, match.account, match.tokenId)
      if (balance === 0n) continue
      log(
        `  found mint-event match -> ${match.account} | balance ${format(balance)}`
      )
      matches.push(
        toSource(
          match.account,
          "**mint event, operator-confirmed**",
          match.tokenId,
          balance
        )
      )
    }
    // A mint of the same amount and token is not proof that it credited this
    // request, so the operator must confirm the account after checking it.
    if (matches.length > 0 && mintSource === undefined) {
      throw new Error(
        `No order address of ${deposit.requestId} is funded. Hub mints of the exact deposit amount went to ${matches.map((match) => match.account).join(", ")}, but a mint match is not tied to the request. Confirm the account belongs to this deposit, then rerun with --mint-source ${deposit.requestId}=<account>`
      )
    }
    const confirmed = matches.filter((match) =>
      sameAddress(match.account, mintSource ?? "", "ethereum-vm")
    )
    if (matches.length > 0 && confirmed.length === 0) {
      throw new Error(
        `--mint-source ${mintSource} for ${deposit.requestId} is not a funded mint-event match; matches: ${matches.map((match) => match.account).join(", ")}`
      )
    }
    funded.push(...confirmed)
    if (confirmed.length === 1) {
      warnings.push(
        `${deposit.requestId}: source ${confirmed[0].account} was matched by a Hub mint of the deposit amount, not by an order-address derivation, and confirmed by the operator with --mint-source. Check it against the oracle execution before signing`
      )
    }
  }

  if (funded.length === 0) {
    throw new Error(
      `No funded Hub account found for request ${deposit.requestId}; the funds may already have left the order address`
    )
  }
  if (funded.length > 1) {
    throw new Error(
      `Multiple funded Hub accounts found for request ${deposit.requestId}: ${funded.map((source) => source.account).join(", ")}; resolve manually`
    )
  }
  // The receiver alias and token id use the funds' chain-id string, and the
  // allocator only withdraws for a string with a registered payload builder.
  const [source] = funded
  const depository =
    networks[deposit.protocolChainId]?.contracts?.prod?.depository
  if (!depository) {
    throw new Error(
      `No prod depository is configured for ${deposit.protocolChainId}`
    )
  }
  const builder = await deps.payloadBuilderOf(
    source.chainIdString,
    encodeAddressToHex(depository, deposit.family)
  )
  if (BigInt(builder) === 0n) {
    throw new Error(
      `${deposit.requestId}: the funds use the chain-id string "${source.chainIdString}", which has no payload builder for depository ${depository} on the allocator, so the recovery account could not withdraw them; resolve manually`
    )
  }
  if (source.chainIdString !== deposit.protocolChainId) {
    warnings.push(
      `${deposit.requestId}: the funds and the receiver alias use the chain-id string "${source.chainIdString}" (payload builder ${builder}), not the oracle's current "${deposit.protocolChainId}"; withdrawals must use that string`
    )
  }
  return source
}

/// Resolves every request to its funded Hub account and builds one
/// RelayHub.transferFrom per account to the recovery account's alias.
export async function planRecoveryTransfers(
  options: RecoveryOptions,
  deps: RecoveryDependencies
): Promise<RecoveryPlan> {
  const log = deps.log ?? (() => undefined)
  if (options.requestIds.length === 0) {
    throw new Error("At least one request id is required")
  }
  const requestIds = [...new Set(options.requestIds.map((id) => id.trim()))]
  for (const requestId of requestIds) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(requestId)) {
      throw new Error(`Invalid request id ${requestId}`)
    }
  }
  const mintSources = options.mintSources ?? {}
  for (const requestId of Object.keys(mintSources)) {
    if (!requestIds.includes(requestId)) {
      throw new Error(
        `--mint-source names ${requestId}, which is not recovered`
      )
    }
  }
  const scanHours = options.mintScanHours ?? DEFAULT_MINT_SCAN_HOURS
  const apiUrl = options.apiUrl ?? DEFAULT_RELAY_API_URL
  const protocolChainIds = await fetchProtocolChainIds(deps, apiUrl)

  const warnings: string[] = []
  const deposits: RecoveryDeposit[] = []
  for (const requestId of requestIds) {
    const deposit = await fetchDeposit(
      requestId,
      deps,
      protocolChainIds,
      apiUrl
    )
    log(
      `request ${requestId} (${deposit.status ?? "unknown status"})\n  depositor ${deposit.depositor} | deposited ${formatUnits(deposit.amount, deposit.decimals)} ${deposit.symbol ?? deposit.currency} on ${deposit.protocolChainId}`
    )
    if (deposit.decimalsUnknown) {
      warnings.push(
        `${requestId}: the decimals of ${deposit.currency} are unknown; its amounts are shown in base units`
      )
    }
    deposits.push(deposit)
  }

  // One recovery account can only withdraw on chains of a single VM.
  const families = [...new Set(deposits.map((deposit) => deposit.family))]
  if (families.length > 1) {
    throw new Error(
      `Requests span several VMs (${families.join(", ")}); run one recovery per VM with a receiver of that VM`
    )
  }
  const receiver = normalizeReceiver(options.receiver, families[0])
  for (const deposit of deposits) {
    if (sameAddress(deposit.depositor, receiver, deposit.family)) {
      throw new Error(
        `Receiver ${receiver} is the depositor of ${deposit.requestId}; recovery must not return funds to the depositor`
      )
    }
  }

  const located: RecoverySource[] = []
  for (const deposit of deposits) {
    located.push(
      await locateSource(
        deps,
        deposit,
        receiver,
        scanHours,
        mintSources[deposit.requestId],
        warnings
      )
    )
  }

  const merged = mergeSources(located)
  warnings.push(...merged.warnings)
  const sources = merged.sources

  const tokens = new Set(
    sources.map((source) => `${source.protocolChainId}-${source.currency}`)
  )
  if (options.expectedTotal !== undefined && tokens.size > 1) {
    throw new Error(
      "--expected-total adds base units, so it needs every request to use the same token and chain; run one recovery per token"
    )
  }
  const total = sources.reduce((sum, source) => sum + source.amount, 0n)
  if (options.expectedTotal !== undefined && total !== options.expectedTotal) {
    throw new Error(
      `Total to transfer ${total} differs from --expected-total ${options.expectedTotal} (base units); nothing was written`
    )
  }

  // Pending manifests claiming the same slots are caught after writing, with
  // findNonceConflicts, as in the other generators.
  const startNonce = await deps.hubClient.getTransactionCount({
    address: deps.signerAddress,
  })

  const transactions: RecoveryTransaction[] = []
  for (const [index, source] of sources.entries()) {
    // The signer holds OPERATOR_ROLE on the Hub, so it may call transferFrom
    // for any account without an allowance.
    const calldata = encodeFunctionData({
      abi: RelayHub,
      args: [source.account, source.receiver, source.tokenId, source.amount],
      functionName: "transferFrom",
    })
    // estimateGas also checks the call succeeds from the signer account.
    const gas = await deps.hubClient.estimateGas({
      account: deps.signerAddress,
      data: calldata,
      to: deps.hubAddress,
    })
    transactions.push({
      amount: "0",
      calldata,
      family: "ethereum-vm",
      from: deps.signerAddress,
      gas: ((gas * 110n) / 100n).toString(),
      maxFeePerGas: deps.gasConfig.maxFeePerGas.toString(),
      maxPriorityFeePerGas: deps.gasConfig.maxPriorityFeePerGas.toString(),
      nonce: startNonce + index,
      rpc: deps.hubRpcUrl,
      to: deps.hubAddress,
    })
  }

  return {
    receiver,
    signer: deps.signerAddress,
    sources,
    transactions,
    warnings,
  }
}

/// Markdown summary for the council signers and the incident record.
export const renderSummary = (plan: RecoveryPlan, manifestPath?: string) => {
  const totals = new Map<string, { amount: bigint; source: RecoverySource }>()
  for (const source of plan.sources) {
    const key = `${source.protocolChainId}-${source.currency}`
    const current = totals.get(key)
    totals.set(key, {
      amount: (current?.amount ?? 0n) + source.amount,
      source,
    })
  }

  const lines = [
    "## Hub recovery transfer",
    "",
    `- Recovery account: \`${plan.receiver}\``,
    `- Hub signer: \`${plan.signer}\``,
    ...(manifestPath ? [`- Manifest: \`${manifestPath}\``] : []),
    "",
    "| Request | Source (Hub) | Derivation | Amount | Deposited | Receiver alias | Nonce |",
    "| --- | --- | --- | ---: | ---: | --- | ---: |",
    ...plan.sources.map(
      (source, index) =>
        `| ${source.requests.map(({ requestId, depositedAmount }) => `\`${requestId}\`${source.requests.length > 1 ? ` (${formatUnits(depositedAmount, source.decimals)})` : ""}`).join("<br>")} | \`${source.account}\` | ${source.label} | ${formatUnits(source.amount, source.decimals)} | ${formatUnits(source.depositedAmount, source.decimals)} | \`${source.receiver}\` (${source.chainIdString}) | ${plan.transactions[index]?.nonce ?? "-"} |`
    ),
    "",
    "Totals:",
    ...[...totals.values()].map(
      ({ amount, source }) =>
        `- ${formatUnits(amount, source.decimals)} ${source.symbol ?? ""} (\`${source.currency}\` on ${source.protocolChainId}, ${amount} base units)`
    ),
  ]
  if (plan.warnings.length > 0) {
    lines.push("", "Warnings:", ...plan.warnings.map((w) => `- ${w}`))
  }
  return lines.join("\n")
}

async function main() {
  const options = new Command()
    .description(
      "Generate a security-council manifest moving Hub order balances of the given requests to a recovery account"
    )
    .requiredOption(
      "--request-id <ids...>",
      "Relay request ids whose Hub order balances are recovered"
    )
    .requiredOption(
      "--receiver <address>",
      "Recovery account on the deposit chain's VM (EVM, Solana or Tron); funds go to its Hub alias"
    )
    .requiredOption(
      "--label <name>",
      "Neutral manifest label, e.g. an internal incident id (lowercase, digits, dashes). Never a victim or attacker name: manifests are public"
    )
    .option(
      "--expected-total <integer>",
      "Refuse unless the total transferred equals this amount in base units"
    )
    .option(
      "--mint-scan-hours <number>",
      "Hours after the deposit to scan Hub mints when no derivation is funded",
      String(DEFAULT_MINT_SCAN_HOURS)
    )
    .option(
      "--mint-source <requestId=hubAddress...>",
      "Hub account confirmed by the operator for a request found only through the mint-event fallback"
    )
    .option("--api-url <url>", "Relay API base URL", DEFAULT_RELAY_API_URL)
    .option("--dry-run", "Print the plan without writing a manifest")
    .parse()
    .opts<{
      apiUrl: string
      dryRun?: boolean
      expectedTotal?: string
      label: string
      mintScanHours: string
      mintSource?: string[]
      receiver: string
      requestId: string[]
    }>()

  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(options.label)) {
    throw new Error("--label must be lowercase letters, digits and dashes")
  }
  if (options.expectedTotal && !/^[0-9]+$/.test(options.expectedTotal)) {
    throw new Error("--expected-total must be an integer in base units")
  }
  const mintScanHours = Number(options.mintScanHours)
  if (!Number.isFinite(mintScanHours) || mintScanHours <= 0) {
    throw new Error("--mint-scan-hours must be a positive number")
  }
  const mintSources: Record<string, string> = {}
  for (const entry of options.mintSource ?? []) {
    const [requestId, account] = entry.split("=")
    if (!requestId || !account || !isAddress(account)) {
      throw new Error(`--mint-source ${entry} must be <requestId>=<hubAddress>`)
    }
    mintSources[requestId.trim()] = account
  }

  // Imported lazily so the planner can be tested without the MPC signer.
  const {
    createRelayChainClient,
    getSignerAddress,
    RELAY_CHAIN_GAS_CONFIG,
    RELAY_CHAIN_HUB_ADDRESS,
  } = await import("./helpers/chains")
  const { getManifestPath } = await import("./helpers/manifest")
  const { describeNonceConflicts, findNonceConflicts } = await import(
    "../src/helpers/nonceConflicts"
  )

  const apiKey = process.env.RELAY_API_KEY
  if (!apiKey) {
    console.warn(
      "RELAY_API_KEY is not set: using the deprecated public /requests/v2 (retired on 2026-11-24)"
    )
  }

  const signerAddress = (await getSignerAddress()) as Hex
  console.log(`Hub signer from MPC: ${signerAddress}`)
  const { client, rpcUrl } = createRelayChainClient()

  const plan = await planRecoveryTransfers(
    {
      apiUrl: options.apiUrl.replace(/\/+$/, ""),
      expectedTotal: options.expectedTotal
        ? BigInt(options.expectedTotal)
        : undefined,
      mintScanHours,
      mintSources,
      receiver: options.receiver,
      requestIds: options.requestId,
    },
    {
      evmOriginClientFor: (protocolChainId) => {
        const rpc = networks[protocolChainId]?.rpc?.[0]
        if (!rpc) throw new Error(`No RPC configured for ${protocolChainId}`)
        return createPublicClient({
          transport: http(rpc),
        }) as unknown as EvmOriginClient
      },
      fetchJson: async (url) => {
        // v2 is rate limited without a Retry-After header: back off a few times.
        for (let attempt = 0; ; attempt++) {
          const res = await fetch(url, {
            headers: apiKey ? { "x-api-key": apiKey } : undefined,
            signal: AbortSignal.timeout(API_TIMEOUT_MS),
          })
          if (res.status === 429 && attempt < 4) {
            await new Promise((r) => setTimeout(r, 2_000 * 2 ** attempt))
            continue
          }
          if (!res.ok) {
            throw new Error(
              `Relay API request failed: ${res.status} ${await res.text()}`
            )
          }
          return res.json()
        }
      },
      gasConfig: RELAY_CHAIN_GAS_CONFIG,
      hubAddress: RELAY_CHAIN_HUB_ADDRESS as Hex,
      hubClient: client as unknown as HubClient,
      hubRpcUrl: rpcUrl,
      log: console.log,
      payloadBuilderOf: async (chainIdString, depository) =>
        (await client.readContract({
          abi: ALLOCATOR_ABI,
          address: ALLOCATOR_ADDRESS,
          args: [chainIdString, depository],
          functionName: "payloadBuilders",
        })) as Hex,
      requestsApiVersion: apiKey ? "v3" : "v2",
      signerAddress,
    }
  )

  const path = options.dryRun
    ? undefined
    : getManifestPath("hub-recovery-transfers", options.label)
  if (path) {
    writeFileSync(path, `${stringifyJsonWithBigInt(plan.transactions)}\n`)
    const conflicts = await findNonceConflicts(path)
    if (conflicts.length) {
      unlinkSync(path)
      throw new Error(
        `Nonce conflicts with pending manifests; regenerate once they land or are abandoned:\n${describeNonceConflicts(conflicts)}`
      )
    }
  }

  console.log(`\n${renderSummary(plan, path)}\n`)
  console.log(
    path
      ? `Generated ${path} with ${plan.transactions.length} transaction(s)`
      : "Dry run: no manifest written"
  )
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
