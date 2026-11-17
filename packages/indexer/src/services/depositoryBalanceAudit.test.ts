import {
  generateTokenId,
  getVmTypeNativeCurrency,
} from "@relay-protocol/settlement-sdk"
import assert from "node:assert/strict"
import test from "node:test"
import { id, type Contract } from "ethers"
import type { Queryable } from "../db/connection.js"
import {
  classifyDepositoryBalance,
  formatAuditAmount,
  oracleChainsUrl,
  parseDecimalUnits,
  parseLighterAccountBalance,
  parseOracleChains,
  rpcEnvNameForChain,
  runDepositoryBalanceAudit,
} from "./depositoryBalanceAudit.js"
import { findSharedReserveGroup } from "./sharedReserves.js"

const baseChain = {
  depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31",
  id: "base",
  vmType: "ethereum-vm",
}

class FakeDb {
  updates: unknown[][] = []
  private rows: unknown[]

  constructor(tokenRows: unknown[]) {
    this.rows = tokenRows
  }

  manyOrNone = async () => this.rows

  none = async (_query: string, params: unknown[]) => {
    this.updates.push(params)
  }
}

test("oracleChainsUrl builds the endpoint from the configured base URL", () => {
  assert.equal(
    oracleChainsUrl("https://oracle.example/"),
    "https://oracle.example/chains/v1"
  )
})

for (const oracleApiKey of ["test-oracle-api-key", undefined, ""]) {
  test(`runDepositoryBalanceAudit requests chain metadata with ${
    oracleApiKey
      ? "an API key"
      : oracleApiKey === ""
        ? "an empty API key"
        : "no API key"
  }`, async (t) => {
    const fetchMock = t.mock.method(
      globalThis,
      "fetch",
      async (url: string, options: RequestInit) => {
        assert.equal(url, "https://oracle.example/chains/v1")
        assert.equal(
          new Headers(options.headers).get("x-api-key"),
          oracleApiKey || null
        )
        return Response.json({ chains: [baseChain] })
      }
    )

    const result = await runDepositoryBalanceAudit(
      new FakeDb([]) as unknown as Queryable,
      {} as Contract,
      {
        oracleApiKey,
        oracleApiUrl: "https://oracle.example/",
      }
    )

    assert.equal(fetchMock.mock.callCount(), 1)
    assert.equal(result.checked, 0)
    assert.equal(result.error, 0)
  })
}

test("rpcEnvNameForChain normalizes Oracle chain ids", () => {
  assert.equal(rpcEnvNameForChain("base"), "BASE_RPC_URL")
  assert.equal(rpcEnvNameForChain("arbitrum_nova"), "ARBITRUM_NOVA_RPC_URL")
})

test("parseOracleChains validates and returns supported chain metadata", () => {
  const gatewayChain = {
    id: "polygon-gateway",
    vmType: "gateway-vm",
  }

  assert.deepEqual(parseOracleChains({ chains: [baseChain, gatewayChain] }), [
    baseChain,
  ])
  assert.throws(
    () => parseOracleChains({ chains: [baseChain, baseChain] }),
    /duplicate id base/
  )
  assert.throws(
    () =>
      parseOracleChains({
        chains: [{ id: "base", vmType: "ethereum-vm" }],
      }),
    /chain at index 0 is invalid/
  )
})

test("classifyDepositoryBalance only reports a deficit below supply", () => {
  assert.equal(classifyDepositoryBalance(99n, 100n), "deficit")
  assert.equal(classifyDepositoryBalance(100n, 100n), "covered")
  assert.equal(classifyDepositoryBalance(101n, 100n), "covered")
})

test("formatAuditAmount formats base units with token decimals", () => {
  assert.equal(formatAuditAmount("1234567", 6), "1.234567")
  assert.equal(formatAuditAmount("-25", 6), "-0.000025")
  assert.equal(formatAuditAmount(null, 6), null)
  assert.equal(formatAuditAmount("100", null), null)
})

test("parseDecimalUnits strips precision beyond the token decimals", () => {
  assert.equal(parseDecimalUnits("20.27659246", 2), 2_027n)
  assert.equal(parseDecimalUnits(20.27659246, 2), 2_027n)
})

test("parseLighterAccountBalance separates native collateral from spot balances", () => {
  const account = {
    assets: [
      {
        asset_id: 3,
        balance: "5.000001",
      },
    ],
    collateral: "14726.756257",
  }

  assert.equal(
    parseLighterAccountBalance(
      account,
      getVmTypeNativeCurrency("lighter-vm"),
      6
    ),
    14_726_756_257n
  )
  assert.equal(parseLighterAccountBalance(account, "3", 6), 5_000_001n)
})

test("parseLighterAccountBalance requires native collateral", () => {
  assert.throws(
    () =>
      parseLighterAccountBalance(
        { assets: [] },
        getVmTypeNativeCurrency("lighter-vm"),
        6
      ),
    /missing collateral balance/
  )
})

test("runDepositoryBalanceAudit uses the current Hub supply for an ERC-20 balance check", async () => {
  const tokenId = "123"
  const db = new FakeDb([
    {
      decimals: 6,
      name: "USD Coin on Base",
      origin_asset: null,
      origin_chain_id: null,
      origin_family: null,
      symbol: "base-USDC",
      token_id: tokenId,
    },
  ]) as unknown as Queryable
  const hubContract = {
    tokenMetadata: async () => [
      "USD Coin on Base",
      "base-USDC",
      6,
      "ethereum-vm",
      8453n,
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    ],
    totalSupply: async (id: string) => {
      assert.equal(id, tokenId)
      return 100n
    },
  } as unknown as Contract
  let balanceInput: unknown

  const result = await runDepositoryBalanceAudit(db, hubContract, {
    env: { BASE_RPC_URL: "https://base.example" },
    fetchChains: async () => [baseChain],
    getBalance: async (input) => {
      balanceInput = input
      return 125n
    },
  })

  assert.deepEqual(balanceInput, {
    chainId: "8453",
    currency: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
    depository: baseChain.depository,
    rpcUrl: "https://base.example",
    vmType: "ethereum-vm",
  })
  assert.equal(result.checked, 1)
  assert.equal(result.covered, 1)
  assert.equal(result.deficit, 0)
  assert.equal(result.results[0].chainId, "base")
  assert.equal("chainName" in result.results[0], false)
  assert.equal(result.results[0].delta, "25")
  assert.equal(result.results[0].deltaFormatted, "0.000025")
  assert.equal(result.results[0].depositoryBalanceFormatted, "0.000125")
  assert.equal(result.results[0].totalSupply, "100")
  assert.equal(result.results[0].totalSupplyFormatted, "0.0001")
  assert.equal((db as unknown as FakeDb).updates.length, 1)
})

test("runDepositoryBalanceAudit reports a missing chain RPC without failing the run", async () => {
  const db = new FakeDb([
    {
      decimals: 6,
      name: "USD Coin on Base",
      origin_asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      origin_chain_id: "8453",
      origin_family: "ethereum-vm",
      symbol: "base-USDC",
      token_id: "123",
    },
  ]) as unknown as Queryable

  const result = await runDepositoryBalanceAudit(db, {} as Contract, {
    env: {},
    fetchChains: async () => [baseChain],
    getBalance: async () => {
      throw new Error("balance reader should not be called")
    },
  })

  assert.equal(result.checked, 0)
  assert.equal(result.error, 1)
  assert.match(result.results[0].error ?? "", /Missing required env var/)
})

test("runDepositoryBalanceAudit skips chains missing from the Oracle response", async () => {
  const db = new FakeDb([
    {
      decimals: 6,
      name: "USD Coin on Base",
      origin_asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      origin_chain_id: "8453",
      origin_family: "ethereum-vm",
      symbol: "base-USDC",
      token_id: "123",
    },
  ]) as unknown as Queryable

  const result = await runDepositoryBalanceAudit(db, {} as Contract, {
    env: { BASE_RPC_URL: "https://base.example" },
    fetchChains: async () => [],
    getBalance: async () => {
      throw new Error("balance reader should not be called")
    },
  })

  assert.equal(result.checked, 0)
  assert.equal(result.error, 0)
  assert.equal(result.unsupported, 1)
  assert.match(
    result.results[0].error ?? "",
    /Oracle chain not found for origin chain 8453/
  )
  assert.equal(result.results[0].status, "unsupported")
})

test("runDepositoryBalanceAudit skips tokens with incomplete Hub metadata", async () => {
  const db = new FakeDb([
    {
      decimals: 6,
      name: "USD Coin",
      origin_asset: null,
      origin_chain_id: null,
      origin_family: null,
      symbol: "USDC",
      token_id: "123",
    },
  ]) as unknown as Queryable
  const hubContract = {
    tokenMetadata: async () => [
      "USD Coin",
      "USDC",
      6,
      "ethereum-vm",
      8453n,
      "",
    ],
  } as unknown as Contract

  const result = await runDepositoryBalanceAudit(db, hubContract, {
    env: { BASE_RPC_URL: "https://base.example" },
    fetchChains: async () => [baseChain],
    getBalance: async () => {
      throw new Error("balance reader should not be called")
    },
  })

  assert.equal(result.checked, 0)
  assert.equal(result.error, 0)
  assert.equal(result.unsupported, 1)
  assert.equal(result.results[0].error, null)
  assert.equal(result.results[0].status, "unsupported")
  assert.equal((db as unknown as FakeDb).updates.length, 0)
})

test("runDepositoryBalanceAudit checks Solana and native XRP currencies", async () => {
  const solanaChainId =
    "50176979118388105370421134508366610418687875236156196470082648173271157915018"
  const xrpCurrency = getVmTypeNativeCurrency("xrp-vm")
  const xrpTokenId = generateTokenId({
    address: xrpCurrency,
    chainId: "xrp",
    family: "xrp-vm",
  }).toString()
  const db = new FakeDb([
    {
      decimals: 9,
      name: "Solana",
      origin_asset: getVmTypeNativeCurrency("solana-vm"),
      origin_chain_id: solanaChainId,
      origin_family: "solana-vm",
      symbol: "SOL",
      token_id: "1",
    },
    {
      decimals: 6,
      name: "XRP",
      origin_asset: xrpCurrency,
      origin_chain_id: "537724",
      origin_family: "xrp-vm",
      symbol: "XRP",
      token_id: xrpTokenId,
    },
  ]) as unknown as Queryable
  const hubContract = {
    totalSupply: async (tokenId: string) => (tokenId === "1" ? 100n : 200n),
  } as unknown as Contract
  const balanceInputs: unknown[] = []

  const result = await runDepositoryBalanceAudit(db, hubContract, {
    env: {
      SOLANA_RPC_URL: "https://solana.example",
      XRP_RPC_URL: "https://xrp.example",
    },
    fetchChains: async () => [
      {
        depository: "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2",
        id: "solana",
        vmType: "solana-vm",
      },
      {
        depository: "rJBdWA9p5KwBoqSQTyMdg3UHLsJVzGVu5m",
        id: "xrp",
        vmType: "xrp-vm",
      },
    ],
    getBalance: async (input) => {
      balanceInputs.push(input)
      return input.vmType === "solana-vm" ? 125n : 190n
    },
  })

  assert.equal(result.checked, 2)
  assert.equal(result.covered, 1)
  assert.equal(result.deficit, 1)
  assert.equal(result.error, 0)
  assert.equal(result.results[1].chainId, "xrp")
  assert.deepEqual(
    balanceInputs.map((input) => (input as { vmType: string }).vmType),
    ["solana-vm", "xrp-vm"]
  )
})

test("runDepositoryBalanceAudit checks Bitcoin, TON, and Tron currencies", async () => {
  const bitcoinCurrency = getVmTypeNativeCurrency("bitcoin-vm")
  const db = new FakeDb([
    {
      decimals: 8,
      name: "Bitcoin",
      origin_asset: bitcoinCurrency,
      origin_chain_id: "8253038",
      origin_family: "bitcoin-vm",
      symbol: "BTC",
      token_id: generateTokenId({
        address: bitcoinCurrency,
        chainId: "bitcoin",
        family: "bitcoin-vm",
      }).toString(),
    },
    {
      decimals: 9,
      name: "Toncoin",
      origin_asset: getVmTypeNativeCurrency("ton-vm"),
      origin_chain_id: BigInt(id("ton")).toString(),
      origin_family: "ton-vm",
      symbol: "TON",
      token_id: "2",
    },
    {
      decimals: 6,
      name: "USDT on Tron",
      origin_asset: "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj",
      origin_chain_id: "728126428",
      origin_family: "tron-vm",
      symbol: "tron-USDT",
      token_id: "3",
    },
  ]) as unknown as Queryable
  const hubContract = {
    totalSupply: async () => 100n,
  } as unknown as Contract
  const balanceInputs: unknown[] = []

  const result = await runDepositoryBalanceAudit(db, hubContract, {
    env: {
      BITCOIN_RPC_URL: "https://bitcoin.example",
      TON_RPC_URL: "https://ton.example",
      TRON_RPC_URL: "https://tron.example",
    },
    fetchChains: async () => [
      {
        depository: "bc1qzmtn0q92ayejt2hpffvlktcpmyy7vvsd06sefu",
        id: "bitcoin",
        vmType: "bitcoin-vm",
      },
      {
        depository:
          "0:ab746b034ea036b7ac5147837a57827bd3917bc3f5506d47479e87ec87ef2554",
        id: "ton",
        vmType: "ton-vm",
      },
      {
        depository: "TXtEs6t2oUWQsNos7m68gbHdE9Q5n6x2oN",
        id: "tron",
        vmType: "tron-vm",
      },
    ],
    getBalance: async (input) => {
      balanceInputs.push(input)
      return 100n
    },
  })

  assert.equal(result.checked, 3)
  assert.equal(result.covered, 3)
  assert.equal(result.error, 0)
  assert.deepEqual(
    balanceInputs.map((input) => (input as { vmType: string }).vmType),
    ["bitcoin-vm", "ton-vm", "tron-vm"]
  )
})

test("runDepositoryBalanceAudit checks Hyperliquid and Lighter currencies", async () => {
  const hyperliquidChainId = BigInt(id("hyperliquid")).toString()
  const db = new FakeDb([
    {
      decimals: 6,
      name: "Hyperliquid USDC",
      origin_asset: getVmTypeNativeCurrency("hyperliquid-vm"),
      origin_chain_id: hyperliquidChainId,
      origin_family: "hyperliquid-vm",
      symbol: "hyperliquid-USDC",
      token_id: "1",
    },
    {
      decimals: 8,
      name: "Hyperliquid Spot USDC",
      origin_asset: "0x6d1e7cde53ba9467b783cb7c530ce054",
      origin_chain_id: hyperliquidChainId,
      origin_family: "hyperliquid-vm",
      symbol: "hyperliquid-spot-USDC",
      token_id: "2",
    },
    {
      decimals: 6,
      name: "Lighter USDC",
      origin_asset: "3",
      origin_chain_id: BigInt(id("lighter")).toString(),
      origin_family: "lighter-vm",
      symbol: "lighter-USDC",
      token_id: "3",
    },
  ]) as unknown as Queryable
  const hubContract = {
    totalSupply: async () => 100n,
  } as unknown as Contract
  const balanceInputs: unknown[] = []

  const result = await runDepositoryBalanceAudit(db, hubContract, {
    env: {
      HYPERLIQUID_RPC_URL: "https://hyperliquid.example",
      LIGHTER_RPC_URL: "https://lighter.example",
    },
    fetchChains: async () => [
      {
        depository: "0x66CF0aace1b4E562593beC10eC7868Fba9932224",
        id: "hyperliquid",
        vmType: "hyperliquid-vm",
      },
      {
        depository: "731033",
        id: "lighter",
        vmType: "lighter-vm",
      },
    ],
    getBalance: async (input) => {
      balanceInputs.push(input)
      return 100n
    },
  })

  assert.equal(result.checked, 3)
  assert.equal(result.covered, 3)
  assert.equal(result.error, 0)
  assert.deepEqual(
    balanceInputs.map((input) => (input as { vmType: string }).vmType),
    ["hyperliquid-vm", "hyperliquid-vm", "lighter-vm"]
  )
})

const arcChain = {
  depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31",
  id: "arc",
  vmType: "ethereum-vm",
}
const ARC_USDC = "0x3600000000000000000000000000000000000000"
const arcToken = (currency: string, decimals: number) => ({
  decimals,
  name: currency === ARC_USDC ? "USDC on Arc" : "USDC (gas) on Arc",
  origin_asset: currency,
  origin_chain_id: "5042",
  origin_family: "ethereum-vm",
  symbol: "arc-USDC",
  token_id: generateTokenId({
    address: currency,
    chainId: "arc",
    family: "ethereum-vm",
  }).toString(),
})
const arcNative = arcToken(getVmTypeNativeCurrency("ethereum-vm"), 18)
const arcErc20 = arcToken(ARC_USDC, 6)

// Both representations read the same physical balance: 3,000 USDC
const arcBalance = async (input: { currency: string }) =>
  input.currency === ARC_USDC ? 3_000n * 10n ** 6n : 3_000n * 10n ** 18n

const runArcAudit = (
  supplies: Record<string, bigint>,
  getBalance = arcBalance
) =>
  runDepositoryBalanceAudit(
    new FakeDb([arcNative, arcErc20]) as unknown as Queryable,
    {
      totalSupply: async (tokenId: string) => supplies[tokenId],
    } as unknown as Contract,
    {
      env: { ARC_RPC_URL: "https://arc.example" },
      fetchChains: async () => [arcChain],
      getBalance,
    }
  )

test("findSharedReserveGroup matches native and facade currencies per chain", () => {
  assert.equal(findSharedReserveGroup("5042", ARC_USDC)?.name, "arc-usdc")
  assert.equal(
    findSharedReserveGroup("5042", getVmTypeNativeCurrency("ethereum-vm"))
      ?.name,
    "arc-usdc"
  )
  assert.equal(
    findSharedReserveGroup("988", "0x779DED0c9e1022225f8E0630b35a9b54bE713736")
      ?.name,
    "stable-usdt0"
  )
  assert.equal(findSharedReserveGroup("8453", ARC_USDC), undefined)
  assert.equal(findSharedReserveGroup("5042", null), undefined)
})

test("runDepositoryBalanceAudit flags a shared reserve that each token alone reports covered", async () => {
  // 2,000 native + 2,000 ERC-20 against one 3,000 balance: each token alone
  // is covered, but together they are 1,000 short
  const result = await runArcAudit({
    [arcNative.token_id]: 2_000n * 10n ** 18n,
    [arcErc20.token_id]: 2_000n * 10n ** 6n,
  })

  assert.equal(result.covered, 2)
  assert.equal(result.deficit, 0)
  assert.equal(result.sharedReserveDeficit, 1)
  assert.equal(result.sharedReserves.length, 1)
  const [reserve] = result.sharedReserves
  assert.equal(reserve.group, "arc-usdc")
  assert.equal(reserve.status, "deficit")
  assert.equal(reserve.chainId, "arc")
  assert.equal(reserve.decimals, 18)
  assert.equal(reserve.totalSupplyFormatted, "4000.0")
  assert.equal(reserve.depositoryBalanceFormatted, "3000.0")
  assert.equal(reserve.deltaFormatted, "-1000.0")
  assert.deepEqual(
    reserve.members.map((member) => member.tokenId).sort(),
    [arcNative.token_id, arcErc20.token_id].sort()
  )
})

test("runDepositoryBalanceAudit reports a covered shared reserve with scaled decimals", async () => {
  const result = await runArcAudit({
    [arcNative.token_id]: 1_000n * 10n ** 18n,
    [arcErc20.token_id]: 1_500_500_000n,
  })

  assert.equal(result.sharedReserveDeficit, 0)
  const [reserve] = result.sharedReserves
  assert.equal(reserve.status, "covered")
  assert.equal(reserve.totalSupplyFormatted, "2500.5")
  assert.equal(reserve.deltaFormatted, "499.5")
})

test("runDepositoryBalanceAudit reports a shared reserve error when a member check fails", async () => {
  const result = await runArcAudit(
    {
      [arcNative.token_id]: 1n,
      [arcErc20.token_id]: 1n,
    },
    async (input) => {
      if (input.currency === ARC_USDC) {
        throw new Error("rpc down")
      }
      return 1n
    }
  )

  assert.equal(result.error, 1)
  assert.equal(result.sharedReserveError, 1)
  const [reserve] = result.sharedReserves
  assert.equal(reserve.status, "error")
  assert.match(reserve.error ?? "", new RegExp(arcErc20.token_id))
})

test("runDepositoryBalanceAudit skips the shared check when only one member is indexed", async () => {
  const result = await runDepositoryBalanceAudit(
    new FakeDb([arcErc20]) as unknown as Queryable,
    { totalSupply: async () => 1n } as unknown as Contract,
    {
      env: { ARC_RPC_URL: "https://arc.example" },
      fetchChains: async () => [arcChain],
      getBalance: arcBalance,
    }
  )

  assert.equal(result.covered, 1)
  assert.equal(result.sharedReserves.length, 0)
})

test("runDepositoryBalanceAudit uses declared group decimals when token decimals are not indexed", async () => {
  // A NULL decimals column must not turn a successful member into a failed
  // group check; the group's declared on-chain decimals are used instead
  const result = await runDepositoryBalanceAudit(
    new FakeDb([
      arcNative,
      { ...arcErc20, decimals: null },
    ]) as unknown as Queryable,
    {
      totalSupply: async (tokenId: string) =>
        tokenId === arcErc20.token_id
          ? 2_000n * 10n ** 6n
          : 2_000n * 10n ** 18n,
    } as unknown as Contract,
    {
      env: { ARC_RPC_URL: "https://arc.example" },
      fetchChains: async () => [arcChain],
      getBalance: arcBalance,
    }
  )

  assert.equal(result.covered, 2)
  assert.equal(result.sharedReserveError, 0)
  const [reserve] = result.sharedReserves
  assert.equal(reserve.status, "deficit")
  assert.equal(reserve.totalSupplyFormatted, "4000.0")
  assert.equal(reserve.depositoryBalanceFormatted, "3000.0")
})

test("runDepositoryBalanceAudit reports a shared reserve error when indexed and declared decimals disagree", async () => {
  const result = await runDepositoryBalanceAudit(
    new FakeDb([
      arcNative,
      { ...arcErc20, decimals: 18 },
    ]) as unknown as Queryable,
    { totalSupply: async () => 1n } as unknown as Contract,
    {
      env: { ARC_RPC_URL: "https://arc.example" },
      fetchChains: async () => [arcChain],
      getBalance: arcBalance,
    }
  )

  assert.equal(result.sharedReserveError, 1)
  const [reserve] = result.sharedReserves
  assert.equal(reserve.status, "error")
  assert.equal(reserve.totalSupply, null)
  assert.match(
    reserve.error ?? "",
    new RegExp(`${arcErc20.token_id} \\(indexed 18, declared 6\\)`)
  )
})

test("runDepositoryBalanceAudit re-reads a shared reserve at one instant before comparing", async () => {
  // A 1,000 USDC deposit lands between the two member checks: the native
  // check sees 3,000 of balance, and the reserve is then 4,000 against 4,000
  // of supply. Mixing the stale balance with the later supply would report a
  // false 1,000 deficit.
  let nativeBalanceReads = 0
  const result = await runDepositoryBalanceAudit(
    new FakeDb([arcNative, arcErc20]) as unknown as Queryable,
    {
      totalSupply: async (tokenId: string) =>
        tokenId === arcErc20.token_id
          ? 2_000n * 10n ** 6n
          : 2_000n * 10n ** 18n,
    } as unknown as Contract,
    {
      env: { ARC_RPC_URL: "https://arc.example" },
      fetchChains: async () => [arcChain],
      getBalance: async (input) => {
        if (input.currency === ARC_USDC) {
          return 4_000n * 10n ** 6n
        }
        nativeBalanceReads += 1
        return (nativeBalanceReads === 1 ? 3_000n : 4_000n) * 10n ** 18n
      },
    }
  )

  assert.equal(nativeBalanceReads, 2)
  const [reserve] = result.sharedReserves
  assert.equal(reserve.status, "covered")
  assert.equal(reserve.depositoryBalanceFormatted, "4000.0")
  assert.equal(reserve.totalSupplyFormatted, "4000.0")
})

test("runDepositoryBalanceAudit reports a shared reserve error when the re-read fails", async () => {
  let nativeBalanceReads = 0
  const result = await runDepositoryBalanceAudit(
    new FakeDb([arcNative, arcErc20]) as unknown as Queryable,
    { totalSupply: async () => 1n } as unknown as Contract,
    {
      env: { ARC_RPC_URL: "https://arc.example" },
      fetchChains: async () => [arcChain],
      getBalance: async (input) => {
        if (input.currency !== ARC_USDC && ++nativeBalanceReads > 1) {
          throw new Error("rpc down")
        }
        return arcBalance(input)
      },
    }
  )

  assert.equal(result.covered, 2)
  assert.equal(result.sharedReserveError, 1)
  const [reserve] = result.sharedReserves
  assert.equal(reserve.status, "error")
  assert.match(reserve.error ?? "", /re-read failed: rpc down/)
})
