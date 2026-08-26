// ABOUTME: Generates a manifest that transfers the hub ETH frozen in the
// ABOUTME: INC-13 (Ostium) order addresses to the recovery Safe's virtual
// ABOUTME: address, one hub transferFrom per funded order, via
// ABOUTME: RelayMultisigSigner.
//
// The deposits were credited to per-order addresses on the hub before the
// fills were blocked by wallet screening (INC-13). Each request id is
// resolved through the public Relay API, the deposit's block timestamp is
// read from the origin chain (the API's inTxs timestamp is an indexing time,
// not the block time the order-address derivation hashes), the candidate
// order addresses are derived, and the one actually holding the hub balance
// is used as the transfer source. If no candidate is funded, the hub's mint
// events around the deposit are scanned and matched by exact amount instead.
//
// Per the incident decision, the funds go to an externally-owned Safe as a
// hub balance withdrawable on the deposit chain (Arbitrum) in the deposited
// currency (ETH), so the receiver alias is derived with the same chain-id
// string convention as the funds' token id.
import { writeFileSync } from "fs"
import {
  createPublicClient,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  parseAbiItem,
  zeroAddress,
} from "viem"
import { RelayHub } from "@relay-protocol/settlement-abis"
import {
  generateAddress,
  generateTokenId,
  getOrderAddress,
  getOrderAddressSafe,
} from "@relay-protocol/settlement-sdk"
import { networks } from "@relay-protocol/settlement-networks"
import {
  getSignerAddress,
  createRelayChainClient,
  RELAY_CHAIN_HUB_ADDRESS,
  RELAY_CHAIN_GAS_CONFIG,
} from "./helpers/chains"
import { getManifestPath, stringifyJsonWithBigInt } from "./helpers/manifest"

// Recovery Safe the funds are transferred to (deployed on Arbitrum, the
// chain the deposits originated from).
const SAFE = getAddress("0x96cA0b1CaE9dfD644142255EE9F6ffbf3E5BD9a7")

// Relay request ids of the frozen deposits (INC-13). Each is resolved via the
// Relay API to recover the deposit's depositor, order id, and timestamp.
const REQUEST_IDS = [
  "0x5b661b1fdf006e2cff0cea588c5e68bc55d500daeb2b7f69ffe8128288e136cc",
  "0x43abb06de5b4a25a2363dbb2fd36cc03b0d9d27e3da49b1aa90e19bfdac3bf6f",
  "0x08e0a2574158b9681c50d19439281f0b1173600a265ac70f94b0634e630a98b2",
  "0xc8645d613395775263ecff798fd20453662d3705c9c1adc9bb866c10e07ab8fe",
  "0xffb855bcc866a5abb048e28301cdd63e4b7ab6efedbfe2e81e0921cbb6ceb97e",
  "0xf1e3a1ac4346bde924128a7b26d81e7d2b58be69a30b413966ba7f369aa6e465",
]

const RELAY_API_URL = "https://api.relay.link/requests/v2"

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address caller, address indexed from, address indexed to, uint256 indexed id, uint256 amount)"
)

// How long after the deposit the oracle mint is searched for, and the
// granularity of the log scan (fallback path only). The chunk size halves
// automatically when the RPC rejects a range as too large.
const MINT_SCAN_WINDOW_SECONDS =
  BigInt(process.env.MINT_SCAN_WINDOW_HOURS ?? 6) * 60n * 60n
const LOG_CHUNK_BLOCKS = 10_000n

type Deposit = {
  requestId: string
  orderId: `0x${string}`
  onchainId?: `0x${string}`
  depositor: `0x${string}`
  currency: `0x${string}`
  chainId: number
  amount: bigint
  transactionId: `0x${string}`
  timestamp: bigint
}

const fetchDeposit = async (requestId: string): Promise<Deposit> => {
  const res = await fetch(`${RELAY_API_URL}?id=${requestId}`)
  if (!res.ok) {
    throw new Error(
      `Relay API request failed for ${requestId}: ${res.status} ${await res.text()}`
    )
  }
  const body = (await res.json()) as {
    requests?: {
      protocol?: {
        orderId?: `0x${string}`
        deposit?: {
          origin?: {
            amount: string
            chainId: number
            currency: `0x${string}`
            depositor: `0x${string}`
            onchainId?: `0x${string}`
            transactionId: `0x${string}`
          }
        }
      }
      data?: {
        inTxs?: { hash?: `0x${string}`; timestamp?: number }[]
      }
    }[]
  }

  const request = body.requests?.[0]
  const origin = request?.protocol?.deposit?.origin
  const orderId = request?.protocol?.orderId
  if (!request || !origin || !orderId) {
    throw new Error(`Relay API returned no deposit data for ${requestId}`)
  }

  // The order-address derivation hashes the deposit's block timestamp, so
  // read it from the origin chain — the API's inTxs timestamp is when the
  // deposit was indexed, which can drift from the block time.
  const originRpc = networks[String(origin.chainId)]?.rpc?.[0]
  if (!originRpc) {
    throw new Error(`No RPC configured for origin chain ${origin.chainId}`)
  }
  const originClient = createPublicClient({ transport: http(originRpc) })
  const receipt = await originClient.getTransactionReceipt({
    hash: origin.transactionId,
  })
  const block = await originClient.getBlock({
    blockNumber: receipt.blockNumber,
  })

  const indexedTimestamp = request.data?.inTxs?.find(
    (tx) => tx.hash?.toLowerCase() === origin.transactionId.toLowerCase()
  )?.timestamp
  if (indexedTimestamp && BigInt(indexedTimestamp) !== block.timestamp) {
    console.log(
      `  note: block timestamp ${block.timestamp} differs from API timestamp ${indexedTimestamp}`
    )
  }

  return {
    amount: BigInt(origin.amount),
    chainId: origin.chainId,
    currency: origin.currency,
    depositor: origin.depositor,
    onchainId: origin.onchainId,
    orderId,
    requestId,
    timestamp: block.timestamp,
    transactionId: origin.transactionId,
  }
}

// The exact derivation the oracle used to credit the deposit is recovered by
// probing the combinations of chain id string (slug vs numeric), deposit id
// (order id vs onchain id), and order-address version (legacy vs safe)
// against the actual hub balances.
const orderAddressCandidates = (deposit: Deposit) => {
  const slug = networks[String(deposit.chainId)]?.slug
  const chainIds = [...new Set([slug, String(deposit.chainId)])].filter(
    Boolean
  ) as string[]
  const depositIds = [
    { depositId: deposit.orderId, idLabel: "orderId" },
    ...(deposit.onchainId
      ? [{ depositId: deposit.onchainId, idLabel: "onchainId" }]
      : []),
  ]
  const derivations = [
    { fn: getOrderAddress, fnLabel: "orderAddress" },
    { fn: getOrderAddressSafe, fnLabel: "orderAddressSafe" },
  ]

  const candidates: {
    address: `0x${string}`
    label: string
    tokenId: bigint
  }[] = []
  for (const chainId of chainIds) {
    const tokenId = generateTokenId({
      address: deposit.currency,
      chainId,
      family: "ethereum-vm",
    })
    for (const { depositId, idLabel } of depositIds) {
      for (const { fn, fnLabel } of derivations) {
        candidates.push({
          address: getAddress(
            fn({
              chainId,
              depositId,
              depositor: deposit.depositor,
              timestamp: deposit.timestamp,
              vmType: "ethereum-vm",
            })
          ),
          label: `${fnLabel}(${chainId}, ${idLabel})`,
          tokenId,
        })
      }
    }
  }
  return candidates
}

// Smallest hub block with a timestamp >= target (binary search).
const findBlockByTimestamp = async (
  client: ReturnType<typeof createRelayChainClient>["client"],
  target: bigint
) => {
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

// getLogs over a block range, halving the chunk size whenever the RPC
// rejects a range as too large (code -32005 / "exceeds" limits).
const getMintLogsAdaptive = async (
  client: ReturnType<typeof createRelayChainClient>["client"],
  fromBlock: bigint,
  toBlock: bigint,
  tokenIds?: bigint[]
) => {
  const logs = []
  let start = fromBlock
  let span = LOG_CHUNK_BLOCKS
  while (start <= toBlock) {
    const end = start + span - 1n > toBlock ? toBlock : start + span - 1n
    try {
      logs.push(
        ...(await client.getLogs({
          address: RELAY_CHAIN_HUB_ADDRESS as `0x${string}`,
          args: { from: zeroAddress, ...(tokenIds ? { id: tokenIds } : {}) },
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

// Scan the hub's mint events (Transfer from address(0)) in the window after
// the deposit and return the distinct (account, token id) pairs whose minted
// amount matches the deposit exactly (fallback when no derived candidate is
// funded). Scans the expected ETH token ids first (indexed topic — cheap),
// then falls back to an unfiltered sweep of every mint in the window.
const findMintByAmount = async (
  client: ReturnType<typeof createRelayChainClient>["client"],
  deposit: Deposit
) => {
  const fromBlock = await findBlockByTimestamp(client, deposit.timestamp)
  const toBlock = await findBlockByTimestamp(
    client,
    deposit.timestamp + MINT_SCAN_WINDOW_SECONDS
  )

  const slug = networks[String(deposit.chainId)]?.slug
  const expectedTokenIds = [
    ...new Set(
      [String(deposit.chainId), slug].filter(Boolean).map((chainId) =>
        generateTokenId({
          address: deposit.currency,
          chainId: chainId as string,
          family: "ethereum-vm",
        })
      )
    ),
  ]

  const matches = new Map<string, { account: `0x${string}`; tokenId: bigint }>()
  const seen = new Map<string, bigint>()
  const collect = (logs: Awaited<ReturnType<typeof getMintLogsAdaptive>>) => {
    for (const log of logs) {
      const { to, id, amount } = log.args as {
        to: `0x${string}`
        id: bigint
        amount: bigint
      }
      seen.set(`${to.toLowerCase()}-${id}`, amount)
      if (amount !== deposit.amount) continue
      matches.set(`${to.toLowerCase()}-${id}`, { account: to, tokenId: id })
    }
  }

  console.log(
    `  scanning hub mints in blocks ${fromBlock}..${toBlock} for amount ${formatEther(deposit.amount)} (expected token ids first)`
  )
  collect(
    await getMintLogsAdaptive(client, fromBlock, toBlock, expectedTokenIds)
  )

  if (matches.size === 0) {
    console.log("  no match on expected token ids, sweeping every mint")
    collect(await getMintLogsAdaptive(client, fromBlock, toBlock))
  }

  if (matches.size === 0) {
    console.warn(
      `  no exact-amount mint found; ${seen.size} mint(s) observed in the window:`
    )
    for (const [key, amount] of seen) {
      console.warn(`    ${key} | amount ${formatEther(amount)}`)
    }
  }
  return [...matches.values()]
}

// Derive the receiver alias with the same chain-id string convention as the
// funds' token id, so the Safe's withdraw requests (which reuse that chain id
// string) resolve to the alias holding the balance.
const receiverForTokenId = (deposit: Deposit, tokenId: bigint) => {
  const slug = networks[String(deposit.chainId)]?.slug
  for (const chainId of [String(deposit.chainId), slug]) {
    if (!chainId) continue
    const candidate = generateTokenId({
      address: deposit.currency,
      chainId,
      family: "ethereum-vm",
    })
    if (candidate === tokenId) {
      return generateAddress({
        address: SAFE,
        chainId,
        family: "ethereum-vm",
      })
    }
  }
  throw new Error(
    `Token id ${tokenId} does not match any known chain-id string for chain ${deposit.chainId} — derive the receiver alias manually`
  )
}

const main = async () => {
  const signerAddress = (await getSignerAddress()) as `0x${string}`
  console.log(`Using signer from MPC : ${signerAddress}`)
  console.log(`Recovery Safe: ${SAFE}\n`)

  const { client: relayChainClient, rpcUrl } = createRelayChainClient()

  const sources: {
    account: `0x${string}`
    amount: bigint
    tokenId: bigint
    receiver: `0x${string}`
    requestId: string
  }[] = []

  for (const requestId of REQUEST_IDS) {
    const deposit = await fetchDeposit(requestId)
    console.log(
      `request ${requestId}\n  depositor ${deposit.depositor} | order ${deposit.orderId} | deposited ${formatEther(deposit.amount)} (chain ${deposit.chainId}, block ts ${deposit.timestamp})`
    )

    const funded: (typeof sources)[number][] = []
    for (const candidate of orderAddressCandidates(deposit)) {
      const balance = (await relayChainClient.readContract({
        abi: RelayHub,
        address: RELAY_CHAIN_HUB_ADDRESS as `0x${string}`,
        args: [candidate.address, candidate.tokenId],
        functionName: "balanceOf",
      })) as bigint
      if (balance === 0n) continue

      console.log(
        `  ✓ ${candidate.label} -> ${candidate.address} | balance ${formatEther(balance)}`
      )
      if (balance !== deposit.amount) {
        console.warn(
          `    ⚠️  balance differs from deposited amount ${formatEther(deposit.amount)} — transferring the current balance`
        )
      }
      funded.push({
        account: candidate.address,
        amount: balance,
        receiver: receiverForTokenId(deposit, candidate.tokenId),
        requestId,
        tokenId: candidate.tokenId,
      })
    }

    // Fallback: no derivation candidate is funded — recover the credited
    // account from the hub's own mint events instead.
    if (funded.length === 0) {
      console.log(
        "  no derived candidate is funded, falling back to mint-event scan"
      )
      for (const match of await findMintByAmount(relayChainClient, deposit)) {
        const balance = (await relayChainClient.readContract({
          abi: RelayHub,
          address: RELAY_CHAIN_HUB_ADDRESS as `0x${string}`,
          args: [match.account, match.tokenId],
          functionName: "balanceOf",
        })) as bigint
        console.log(
          `  ✓ mint-event match -> ${match.account} | id ${match.tokenId} | balance ${formatEther(balance)}`
        )
        if (balance === 0n) {
          console.warn("    ⚠️  zero balance — funds already moved, skipping")
          continue
        }
        funded.push({
          account: match.account,
          amount: balance < deposit.amount ? balance : deposit.amount,
          receiver: receiverForTokenId(deposit, match.tokenId),
          requestId,
          tokenId: match.tokenId,
        })
      }
    }

    if (funded.length === 0) {
      throw new Error(
        `No funded account found for request ${requestId} — locate the hub mint manually`
      )
    }
    if (funded.length > 1) {
      throw new Error(
        `Multiple funded candidates for request ${requestId} — resolve manually before generating transfers`
      )
    }
    sources.push(funded[0])
  }

  // A single credited account must not be transferred twice, even if two
  // requests resolve to it (e.g. equal amounts in the same scan window).
  const uniqueSources = new Map<string, (typeof sources)[number]>()
  for (const source of sources) {
    const key = `${source.account.toLowerCase()}-${source.tokenId}`
    if (uniqueSources.has(key)) {
      console.warn(
        `⚠️  ${source.account} (id ${source.tokenId}) matched more than one request — transferring its balance once`
      )
      continue
    }
    uniqueSources.set(key, source)
  }
  sources.length = 0
  sources.push(...uniqueSources.values())

  const totalAmount = sources.reduce((sum, s) => sum + s.amount, 0n)
  console.log(
    `\nTotal to transfer: ${formatEther(totalAmount)} across ${sources.length} account(s)`
  )

  // Nonce increments across the batch since all txs share the same signer.
  const startNonce = await relayChainClient.getTransactionCount({
    address: signerAddress,
  })

  const txs = await Promise.all(
    sources.map(async ({ account, amount, tokenId, receiver }, index) => {
      // The signer holds OPERATOR_ROLE on the hub, so isOperator() lets it
      // call transferFrom for any sender without an allowance.
      const calldata = encodeFunctionData({
        abi: RelayHub,
        args: [account, receiver, tokenId, amount],
        functionName: "transferFrom",
      })

      // estimateGas also validates the call succeeds from the signer account.
      const gas = await relayChainClient.estimateGas({
        account: signerAddress,
        data: calldata,
        to: RELAY_CHAIN_HUB_ADDRESS as `0x${string}`,
      })

      console.log(
        `✓ transferFrom(${account}, ${receiver}, id ${tokenId}, ${formatEther(amount)})`
      )

      return {
        amount: "0",
        calldata,
        family: "ethereum-vm",
        from: signerAddress,
        gas: ((gas * 110n) / 100n).toString(),
        maxFeePerGas: RELAY_CHAIN_GAS_CONFIG.maxFeePerGas.toString(),
        maxPriorityFeePerGas:
          RELAY_CHAIN_GAS_CONFIG.maxPriorityFeePerGas.toString(),
        nonce: startNonce + index,
        rpc: rpcUrl,
        to: RELAY_CHAIN_HUB_ADDRESS,
      }
    })
  )

  const path = getManifestPath(
    "inc13-recovery-transfers",
    `ETH-${formatEther(totalAmount)}-to-${SAFE.slice(0, 8)}`
  )
  writeFileSync(path, stringifyJsonWithBigInt(txs))

  console.log(`\n✅ Generated: ${path}`)
  console.log(`📝 Generated ${txs.length} transaction(s)`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
