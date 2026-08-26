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
