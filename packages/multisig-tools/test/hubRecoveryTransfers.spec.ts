import { decodeFunctionData, getAddress, zeroAddress } from "viem"
import { TronWeb } from "tronweb"
import { describe, expect, it, vi } from "vitest"
import { RelayHub } from "@relay-protocol/settlement-abis"
import {
  generateAddress,
  getOrderAddress,
} from "@relay-protocol/settlement-sdk"
import {
  chainIdStrings,
  normalizeReceiver,
  orderAddressCandidates,
  planRecoveryTransfers,
  receiverAlias,
  renderSummary,
  type EvmOriginClient,
  type HubClient,
  type RecoveryDependencies,
} from "../scripts/generate-hub-recovery-transfers"

const HUB = "0xDDD361727C22A01EB137880678A20b0BEaE69318"
const SIGNER = "0x00000000000000000000000000000000000000A1"
const EVM_RECEIVER = getAddress("0x00000000000000000000000000000000000000b2")
const EVM_DEPOSITOR = getAddress("0x00000000000000000000000000000000000000C3")
const EVM_USDT = getAddress("0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9")
const SOL_RECEIVER = "11111111111111111111111111111112"
const SOL_DEPOSITOR = "So11111111111111111111111111111111111111112"
const SOL_USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
const TRON_RECEIVER = "TXtEs6t2oUWQsNos7m68gbHdE9Q5n6x2oN"
const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
const BUILDER = "0x00000000000000000000000000000000000000E5"
const REQUEST_A = `0x${"a".repeat(64)}` as const
const REQUEST_B = `0x${"b".repeat(64)}` as const
const BLOCK_TIME = 1_790_000_000n

type Fixture = {
  amount: bigint
  apiChainId: number
  currency: string
  depositor: string
  orderId?: string
  inTxHash?: string
  apiCurrencyAddress?: string
  withoutCurrencyMetadata?: boolean
}

const evmDeposit = (amount: bigint): Fixture => ({
  amount,
  apiChainId: 42161,
  currency: EVM_USDT,
  depositor: EVM_DEPOSITOR,
})

const solanaDeposit = (amount: bigint): Fixture => ({
  amount,
  apiChainId: 792703809,
  currency: SOL_USDT,
  depositor: SOL_DEPOSITOR,
})

const requestsResponse = (requestId: string, fixture: Fixture) => ({
  requests: [
    {
      data: {
        inTxs: [
          {
            timestamp: Number(BLOCK_TIME),
            txHash: fixture.inTxHash ?? requestId,
          },
        ],
        route: fixture.withoutCurrencyMetadata
          ? undefined
          : {
              actual: {
                origin: {
                  inputCurrency: {
                    currency: {
                      address: fixture.apiCurrencyAddress,
                      chainId: fixture.apiChainId,
                      decimals: 6,
                      symbol: "USDT",
                    },
                  },
                },
              },
            },
      },
      protocol: {
        deposit: {
          origin: {
            amount: fixture.amount.toString(),
            chainId: fixture.apiChainId,
            currency: fixture.currency,
            depositor: fixture.depositor,
            transactionId: requestId,
          },
        },
        orderId: fixture.orderId ?? requestId,
      },
      status: "failure",
    },
  ],
})

const tronDeposit = (amount: bigint, depositor: string): Fixture => ({
  amount,
  apiChainId: 728126428,
  currency: TRON_USDT,
  depositor,
  inTxHash: REQUEST_A.slice(2).toUpperCase(),
  withoutCurrencyMetadata: true,
})

const chainsResponse = {
  chains: [
    { id: 728126428, protocol: { v2: { chainId: "tron" } } },
    { id: 42161, protocol: { v2: { chainId: "arbitrum" } } },
    { id: 792703809, protocol: { v2: { chainId: "solana" } } },
  ],
}

const orderAddressOf = (requestId: string, chainId: string) =>
  getAddress(getOrderAddress({ chainId, depositId: requestId }))

const setup = (options: {
  deposits: Record<string, Fixture>
  balances: Record<string, bigint>
  onchainNonce?: number
  payloadBuilder?: (_chainIdString: string) => string
  mints?: { to: string; amount: bigint; id: bigint }[]
}) => {
  const hubClient: HubClient = {
    estimateGas: vi.fn(async () => 100_000n),
    getBlock: vi.fn(async () => ({ number: 1n, timestamp: BLOCK_TIME })),
    getLogs: vi.fn(async () =>
      (options.mints ?? []).map((mint) => ({
        args: { ...mint, to: mint.to as `0x${string}` },
      }))
    ),
    getTransactionCount: vi.fn(async () => options.onchainNonce ?? 10),
    readContract: vi.fn(
      async ({ args: [account] }) =>
        options.balances[account.toLowerCase()] ?? 0n
    ),
  }
  const evmOriginClient: EvmOriginClient = {
    getBlock: vi.fn(async () => ({ timestamp: BLOCK_TIME })),
    getTransactionReceipt: vi.fn(async () => ({ blockNumber: 5n })),
    readContract: vi.fn(async () => 6),
  }
  const deps: RecoveryDependencies = {
    evmOriginClientFor: vi.fn(() => evmOriginClient),
    fetchJson: vi.fn(async (url: string) => {
      const parsed = new URL(url)
      if (parsed.pathname === "/chains") return chainsResponse
      const id = parsed.searchParams.get("id") as string
      return requestsResponse(id, options.deposits[id])
    }),
    gasConfig: { maxFeePerGas: 7n, maxPriorityFeePerGas: 0n },
    hubAddress: HUB,
    hubClient,
    hubRpcUrl: "https://hub.example",
    payloadBuilderOf: vi.fn(
      async (chainIdString: string) =>
        (options.payloadBuilder?.(chainIdString) ?? BUILDER) as `0x${string}`
    ),
    requestsApiVersion: "v3",
    signerAddress: SIGNER,
  }
  return { deps, evmOriginClient, hubClient }
}

describe("chainIdStrings", () => {
  it("starts with the protocol chain id and adds the numeric ids", () => {
    expect(
      chainIdStrings({ apiChainId: 42161, protocolChainId: "arbitrum" })
    ).toEqual(["arbitrum", "42161"])
  })
})

describe("normalizeReceiver", () => {
  it("validates receivers per VM", () => {
    expect(normalizeReceiver(EVM_RECEIVER.toLowerCase(), "ethereum-vm")).toBe(
      EVM_RECEIVER
    )
    expect(normalizeReceiver(SOL_RECEIVER, "solana-vm")).toBe(SOL_RECEIVER)
    expect(() => normalizeReceiver(EVM_RECEIVER, "solana-vm")).toThrow()
    expect(() => normalizeReceiver(SOL_RECEIVER, "ethereum-vm")).toThrow()
    expect(normalizeReceiver(TRON_RECEIVER, "tron-vm")).toBe(TRON_RECEIVER)
    const brokenChecksum = `${TRON_RECEIVER.slice(0, -1)}M`
    expect(() => normalizeReceiver(brokenChecksum, "tron-vm")).toThrow()
  })
})

describe("orderAddressCandidates", () => {
  it("includes the current derivation for every chain-id string", () => {
    const candidates = orderAddressCandidates({
      amount: 1n,
      apiChainId: 42161,
      currency: EVM_USDT,
      decimals: 6,
      depositor: EVM_DEPOSITOR,
      family: "ethereum-vm",
      orderId: REQUEST_A,
      protocolChainId: "arbitrum",
      requestId: REQUEST_A,
      timestamp: BLOCK_TIME,
      timestampApproximate: false,
      transactionId: REQUEST_A,
    })
    expect(candidates.map((c) => c.address)).toContain(
      orderAddressOf(REQUEST_A, "arbitrum")
    )
    // 2 chain-id strings x 1 deposit id x 2 derivations
    expect(candidates).toHaveLength(4)
  })
})

describe("receiverAlias", () => {
  it("derives the alias for the funds' chain-id string", () => {
    expect(receiverAlias(SOL_RECEIVER, "solana", "solana-vm")).toBe(
      getAddress(
        generateAddress({
          address: SOL_RECEIVER,
          chainId: "solana",
          family: "solana-vm",
        })
      )
    )
  })
})

describe("planRecoveryTransfers", () => {
  it("transfers Solana order balances to the receiver's Solana alias", async () => {
    const { deps, evmOriginClient } = setup({
      balances: {
        [orderAddressOf(REQUEST_A, "solana").toLowerCase()]: 150_000_000_000n,
        [orderAddressOf(REQUEST_B, "solana").toLowerCase()]: 40_000_000_000n,
      },
      deposits: {
        [REQUEST_A]: solanaDeposit(150_000_000_000n),
        [REQUEST_B]: solanaDeposit(40_000_000_000n),
      },
      onchainNonce: 12,
    })

    const plan = await planRecoveryTransfers(
      {
        expectedTotal: 190_000_000_000n,
        receiver: SOL_RECEIVER,
        requestIds: [REQUEST_A, REQUEST_B],
      },
      deps
    )

    expect(evmOriginClient.getTransactionReceipt).not.toHaveBeenCalled()
    expect(
      vi
        .mocked(deps.fetchJson)
        .mock.calls.filter(([url]) => new URL(url).pathname === "/chains")
    ).toHaveLength(1)
    expect(plan.transactions.map((tx) => tx.nonce)).toEqual([12, 13])
    const decoded = decodeFunctionData({
      abi: RelayHub,
      data: plan.transactions[0].calldata,
    })
    expect(decoded.functionName).toBe("transferFrom")
    expect(decoded.args?.[0]).toBe(orderAddressOf(REQUEST_A, "solana"))
    expect(decoded.args?.[1]).toBe(
      receiverAlias(SOL_RECEIVER, "solana", "solana-vm")
    )
    expect(decoded.args?.[3]).toBe(150_000_000_000n)
    expect(plan.warnings).toEqual([])

    const summary = renderSummary(plan, "transactions/prod/001-x.json")
    expect(summary).toContain("| 150000 |")
    expect(summary).toContain("190000 USDT")
  })

  it("reads the EVM block time and transfers to the EVM alias", async () => {
    const { deps, evmOriginClient } = setup({
      balances: {
        [orderAddressOf(REQUEST_A, "arbitrum").toLowerCase()]: 100n,
      },
      deposits: { [REQUEST_A]: evmDeposit(100n) },
    })
    const plan = await planRecoveryTransfers(
      { receiver: EVM_RECEIVER, requestIds: [REQUEST_A] },
      deps
    )
    expect(evmOriginClient.getTransactionReceipt).toHaveBeenCalled()
    expect(plan.sources[0].receiver).toBe(
      receiverAlias(EVM_RECEIVER, "arbitrum", "ethereum-vm")
    )
  })

  it("falls back to 18 decimals for an EVM native deposit without currency metadata", async () => {
    const { deps } = setup({
      balances: {
        [orderAddressOf(REQUEST_A, "arbitrum").toLowerCase()]: 10n ** 18n,
      },
      deposits: {
        [REQUEST_A]: {
          ...evmDeposit(10n ** 18n),
          currency: zeroAddress,
          withoutCurrencyMetadata: true,
        },
      },
    })
    const plan = await planRecoveryTransfers(
      { receiver: EVM_RECEIVER, requestIds: [REQUEST_A] },
      deps
    )
    expect(plan.sources[0].decimals).toBe(18)
  })

  it("merges requests credited to the same account into one capped transfer", async () => {
    const shared = orderAddressOf(REQUEST_A, "solana")
    const { deps } = setup({
      balances: { [shared.toLowerCase()]: 300n },
      deposits: {
        [REQUEST_A]: solanaDeposit(100n),
        [REQUEST_B]: { ...solanaDeposit(150n), orderId: REQUEST_A },
      },
    })
    const plan = await planRecoveryTransfers(
      {
        expectedTotal: 250n,
        receiver: SOL_RECEIVER,
        requestIds: [REQUEST_A, REQUEST_B],
      },
      deps
    )
    expect(plan.transactions).toHaveLength(1)
    expect(plan.sources[0].requests).toEqual([
      { depositedAmount: 100n, requestId: REQUEST_A },
      { depositedAmount: 150n, requestId: REQUEST_B },
    ])
    expect(renderSummary(plan)).toContain(`\`${REQUEST_B}\` (0.00015)`)
    const decoded = decodeFunctionData({
      abi: RelayHub,
      data: plan.transactions[0].calldata,
    })
    expect(decoded.args?.[0]).toBe(shared)
    expect(decoded.args?.[3]).toBe(250n)
    expect(plan.warnings.join("\n")).toMatch(/combined deposits/)
    expect(plan.warnings.join("\n")).toMatch(/exceeds the deposit/)
  })

  it("uses a mint-event match only when the operator confirms it", async () => {
    const unrelated = getAddress("0x00000000000000000000000000000000000000D4")
    const tokenId = orderAddressCandidates({
      amount: 100n,
      apiChainId: 792703809,
      currency: SOL_USDT,
      decimals: 6,
      depositor: SOL_DEPOSITOR,
      family: "solana-vm",
      orderId: REQUEST_A,
      protocolChainId: "solana",
      requestId: REQUEST_A,
      timestamp: BLOCK_TIME,
      timestampApproximate: true,
      transactionId: REQUEST_A,
    })[0].tokenId
    const { deps } = setup({
      balances: { [unrelated.toLowerCase()]: 100n },
      deposits: { [REQUEST_A]: solanaDeposit(100n) },
      mints: [{ amount: 100n, id: tokenId, to: unrelated }],
    })

    await expect(
      planRecoveryTransfers(
        { receiver: SOL_RECEIVER, requestIds: [REQUEST_A] },
        deps
      )
    ).rejects.toThrow(/--mint-source/)

    const plan = await planRecoveryTransfers(
      {
        mintSources: { [REQUEST_A]: unrelated.toLowerCase() },
        receiver: SOL_RECEIVER,
        requestIds: [REQUEST_A],
      },
      deps
    )
    expect(plan.sources[0].account).toBe(unrelated)
    expect(plan.warnings[0]).toMatch(/confirmed by the operator/)
    expect(renderSummary(plan)).toContain("mint event, operator-confirmed")
  })

  it("warns when the funds use a legacy chain-id string", async () => {
    const { deps } = setup({
      balances: {
        [orderAddressOf(REQUEST_A, "42161").toLowerCase()]: 100n,
      },
      deposits: { [REQUEST_A]: evmDeposit(100n) },
    })
    const plan = await planRecoveryTransfers(
      { receiver: EVM_RECEIVER, requestIds: [REQUEST_A] },
      deps
    )
    expect(plan.sources[0].receiver).toBe(
      receiverAlias(EVM_RECEIVER, "42161", "ethereum-vm")
    )
    expect(plan.warnings[0]).toMatch(
      /"42161" .*not the oracle's current "arbitrum"/
    )
  })

  it("refuses funds under a chain-id string without a payload builder", async () => {
    const { deps } = setup({
      balances: {
        [orderAddressOf(REQUEST_A, "42161").toLowerCase()]: 100n,
      },
      deposits: { [REQUEST_A]: evmDeposit(100n) },
      payloadBuilder: (chainIdString) =>
        chainIdString === "arbitrum" ? BUILDER : zeroAddress,
    })
    await expect(
      planRecoveryTransfers(
        { receiver: EVM_RECEIVER, requestIds: [REQUEST_A] },
        deps
      )
    ).rejects.toThrow(/"42161", which has no payload builder/)
  })

  it("ignores the API symbol when its currency is not the deposited one", async () => {
    const { deps } = setup({
      balances: {
        [orderAddressOf(REQUEST_A, "solana").toLowerCase()]: 100n,
      },
      deposits: {
        [REQUEST_A]: {
          ...solanaDeposit(100n),
          apiCurrencyAddress: SOL_RECEIVER,
        },
      },
    })
    const plan = await planRecoveryTransfers(
      { receiver: SOL_RECEIVER, requestIds: [REQUEST_A] },
      deps
    )
    expect(plan.sources[0].symbol).toBeUndefined()
    expect(renderSummary(plan)).not.toContain("USDT")
  })

  it("caps the transfer at the deposited amount and warns", async () => {
    const { deps } = setup({
      balances: { [orderAddressOf(REQUEST_A, "solana").toLowerCase()]: 200n },
      deposits: { [REQUEST_A]: solanaDeposit(150n) },
    })
    const plan = await planRecoveryTransfers(
      { receiver: SOL_RECEIVER, requestIds: [REQUEST_A] },
      deps
    )
    expect(plan.sources[0].amount).toBe(150n)
    expect(plan.warnings[0]).toMatch(/exceeds the deposit/)
  })

  it("refuses to send funds back to the depositor", async () => {
    const { deps } = setup({
      balances: { [orderAddressOf(REQUEST_A, "solana").toLowerCase()]: 1n },
      deposits: { [REQUEST_A]: solanaDeposit(1n) },
    })
    await expect(
      planRecoveryTransfers(
        { receiver: SOL_DEPOSITOR, requestIds: [REQUEST_A] },
        deps
      )
    ).rejects.toThrow(/depositor/)
  })

  it("refuses a Tron receiver that is the depositor in another address form", async () => {
    const { deps } = setup({
      balances: {},
      deposits: {
        [REQUEST_A]: tronDeposit(1n, TronWeb.address.toHex(TRON_RECEIVER)),
      },
    })
    await expect(
      planRecoveryTransfers(
        { receiver: TRON_RECEIVER, requestIds: [REQUEST_A] },
        deps
      )
    ).rejects.toThrow(/depositor/)
  })

  it("shows base units when a Tron deposit has no currency metadata", async () => {
    const { deps } = setup({
      balances: { [orderAddressOf(REQUEST_A, "tron").toLowerCase()]: 5n },
      deposits: { [REQUEST_A]: tronDeposit(5n, TRON_USDT) },
    })
    const plan = await planRecoveryTransfers(
      { receiver: TRON_RECEIVER, requestIds: [REQUEST_A] },
      deps
    )
    expect(plan.sources[0].amount).toBe(5n)
    expect(plan.warnings[0]).toMatch(/base units/)
  })

  it("refuses requests spanning several VMs", async () => {
    const { deps } = setup({
      balances: {},
      deposits: { [REQUEST_A]: solanaDeposit(1n), [REQUEST_B]: evmDeposit(1n) },
    })
    await expect(
      planRecoveryTransfers(
        { receiver: SOL_RECEIVER, requestIds: [REQUEST_A, REQUEST_B] },
        deps
      )
    ).rejects.toThrow(/several VMs/)
  })

  it("refuses when the total differs from the expected total", async () => {
    const { deps } = setup({
      balances: { [orderAddressOf(REQUEST_A, "solana").toLowerCase()]: 100n },
      deposits: { [REQUEST_A]: solanaDeposit(100n) },
    })
    await expect(
      planRecoveryTransfers(
        { expectedTotal: 99n, receiver: SOL_RECEIVER, requestIds: [REQUEST_A] },
        deps
      )
    ).rejects.toThrow(/expected-total/)
  })

  it("refuses --expected-total when requests use different tokens", async () => {
    const { deps } = setup({
      balances: {
        [orderAddressOf(REQUEST_A, "solana").toLowerCase()]: 100n,
        [orderAddressOf(REQUEST_B, "solana").toLowerCase()]: 100n,
      },
      deposits: {
        [REQUEST_A]: solanaDeposit(100n),
        [REQUEST_B]: { ...solanaDeposit(100n), currency: SOL_RECEIVER },
      },
    })
    await expect(
      planRecoveryTransfers(
        {
          expectedTotal: 200n,
          receiver: SOL_RECEIVER,
          requestIds: [REQUEST_A, REQUEST_B],
        },
        deps
      )
    ).rejects.toThrow(/same token/)
  })

  it("refuses when no Hub account holds the funds", async () => {
    const { deps, hubClient } = setup({
      balances: {},
      deposits: { [REQUEST_A]: solanaDeposit(100n) },
    })
    await expect(
      planRecoveryTransfers(
        { receiver: SOL_RECEIVER, requestIds: [REQUEST_A] },
        deps
      )
    ).rejects.toThrow(/No funded Hub account/)
    expect(hubClient.getLogs).toHaveBeenCalled()
  })

  it("rejects malformed request ids before any lookup", async () => {
    const { deps } = setup({ balances: {}, deposits: {} })
    await expect(
      planRecoveryTransfers(
        { receiver: SOL_RECEIVER, requestIds: [zeroAddress] },
        deps
      )
    ).rejects.toThrow(/Invalid request id/)
    expect(deps.fetchJson).not.toHaveBeenCalled()
  })
})
