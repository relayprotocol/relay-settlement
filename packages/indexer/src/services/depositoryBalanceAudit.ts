import { networks } from "@relay-protocol/settlement-networks"
import {
  encodeAddressToHex,
  generateTokenId,
  getVmTypeNativeCurrency,
  type VmType,
} from "@relay-protocol/settlement-sdk"
import { getAssociatedTokenAddressSync } from "@solana/spl-token"
import { Connection, PublicKey } from "@solana/web3.js"
import {
  Contract,
  formatUnits,
  id,
  Interface,
  JsonRpcProvider,
  ZeroAddress,
} from "ethers"
import type { Queryable } from "../db/connection.js"

const erc20BalanceAbi = [
  "function balanceOf(address account) view returns (uint256)",
]
const erc20BalanceInterface = new Interface(erc20BalanceAbi)
const SUPPORTED_VM_TYPES = new Set([
  "bitcoin-vm",
  "ethereum-vm",
  "hyperliquid-vm",
  "lighter-vm",
  "solana-vm",
  "ton-vm",
  "tron-vm",
  "xrp-vm",
])
const NATIVE_ONLY_VM_TYPES = new Set(["bitcoin-vm", "ton-vm", "xrp-vm"])

export type DepositoryBalanceAuditStatus =
  | "covered"
  | "deficit"
  | "error"
  | "unsupported"

export type OracleChain = {
  depository: string
  id: string
  vmType: string
}

type TokenAuditRow = {
  decimals: number | null
  name: string | null
  origin_asset: string | null
  origin_chain_id: string | null
  origin_family: string | null
  symbol: string | null
  token_id: string
}

type TokenOriginMetadata = {
  decimals: number
  name: string
  originAsset: string
  originChainId: string
  originFamily: string
  symbol: string
}

export type BalanceInput = {
  chainId: string
  currency: string
  decimals: number | null
  depository: string
  rpcUrl: string
  vmType: string
}

type RunOptions = {
  env?: NodeJS.ProcessEnv
  fetchChains?: () => Promise<OracleChain[]>
  oracleApiKey?: string
  oracleApiUrl?: string
  getBalance?: (_input: BalanceInput) => Promise<bigint>
}

export type DepositoryBalanceAuditResult = {
  chainId: string | null
  currency: string | null
  decimals: number | null
  delta: string | null
  deltaFormatted: string | null
  depository: string | null
  depositoryBalance: string | null
  depositoryBalanceFormatted: string | null
  error: string | null
  status: DepositoryBalanceAuditStatus
  tokenId: string
  tokenName: string | null
  tokenSymbol: string | null
  totalSupply: string | null
  totalSupplyFormatted: string | null
  vmType: string | null
}

export const formatAuditAmount = (
  amount: string | null,
  decimals: number | null
) => (amount == null || decimals == null ? null : formatUnits(amount, decimals))

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

export const rpcEnvNameForChain = (chainId: string) =>
  `${chainId.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}_RPC_URL`

export const classifyDepositoryBalance = (
  balance: bigint,
  totalSupply: bigint
): "covered" | "deficit" => (balance >= totalSupply ? "covered" : "deficit")

export const parseOracleChains = (payload: unknown): OracleChain[] => {
  if (!payload || typeof payload !== "object") {
    throw new Error("Oracle chains response must be an object")
  }

  const chains = (payload as { chains?: unknown }).chains
  if (!Array.isArray(chains)) {
    throw new Error("Oracle chains response is missing chains")
  }

  const parsed: OracleChain[] = []
  const seen = new Set<string>()
  chains.forEach((value, index) => {
    if (!value || typeof value !== "object") {
      throw new Error(`Oracle chain at index ${index} must be an object`)
    }

    const chain = value as Partial<OracleChain>
    if (typeof chain.vmType !== "string" || !chain.vmType) {
      throw new Error(`Oracle chain at index ${index} is invalid`)
    }

    if (!SUPPORTED_VM_TYPES.has(chain.vmType)) {
      return
    }

    if (
      typeof chain.id !== "string" ||
      !chain.id ||
      typeof chain.depository !== "string" ||
      !chain.depository
    ) {
      throw new Error(`Oracle chain at index ${index} is invalid`)
    }

    if (seen.has(chain.id)) {
      throw new Error(
        `Oracle chains response contains duplicate id ${chain.id}`
      )
    }
    seen.add(chain.id)

    parsed.push({
      depository: chain.depository,
      id: chain.id,
      vmType: chain.vmType,
    })
  })

  return parsed
}

export const oracleChainsUrl = (oracleApiUrl: string) =>
  `${oracleApiUrl.replace(/\/+$/, "")}/chains/v1`

export const fetchOracleChains = async (
  oracleApiUrl: string,
  oracleApiKey?: string
): Promise<OracleChain[]> => {
  const chainsUrl = oracleChainsUrl(oracleApiUrl)
  const response = await fetch(chainsUrl, {
    headers: oracleApiKey ? { "x-api-key": oracleApiKey } : undefined,
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    throw new Error(
      `Oracle chains request failed: ${response.status} ${response.statusText}`
    )
  }

  return parseOracleChains(await response.json())
}

const metadataValue = (
  metadata: Record<string | number, unknown>,
  name: string,
  index: number
) => metadata[name] ?? metadata[index]

const readTokenOriginMetadata = async (
  hubContract: Contract,
  tokenId: string
): Promise<TokenOriginMetadata> => {
  const raw = (await hubContract.tokenMetadata(tokenId)) as unknown as Record<
    string | number,
    unknown
  >
  const rawDecimals = Number(metadataValue(raw, "decimals", 2))

  return {
    decimals: rawDecimals || 18,
    name: String(metadataValue(raw, "name", 0) ?? ""),
    originAsset: String(metadataValue(raw, "originAsset", 5) ?? ""),
    originChainId: String(metadataValue(raw, "originChainId", 4) ?? ""),
    originFamily: String(metadataValue(raw, "originFamily", 3) ?? ""),
    symbol: String(metadataValue(raw, "symbol", 1) ?? ""),
  }
}

const ensureTokenOriginMetadata = async (
  db: Queryable,
  hubContract: Contract,
  token: TokenAuditRow
): Promise<TokenAuditRow | null> => {
  if (token.origin_family && token.origin_chain_id && token.origin_asset) {
    return token
  }

  const metadata = await readTokenOriginMetadata(hubContract, token.token_id)
  if (
    !metadata.originFamily ||
    !metadata.originChainId ||
    !metadata.originAsset
  ) {
    return null
  }

  const now = new Date().toISOString()
  await db.none(
    `UPDATE tokens
     SET name = $1,
         symbol = $2,
         decimals = $3,
         origin_family = $4,
         origin_chain_id = $5,
         origin_asset = $6,
         updated_at = $7
     WHERE token_id = $8`,
    [
      metadata.name || token.name || "Unknown",
      metadata.symbol || token.symbol,
      metadata.decimals,
      metadata.originFamily,
      metadata.originChainId,
      metadata.originAsset,
      now,
      token.token_id,
    ]
  )

  return {
    ...token,
    decimals: metadata.decimals,
    name: metadata.name || token.name || "Unknown",
    origin_asset: metadata.originAsset,
    origin_chain_id: metadata.originChainId,
    origin_family: metadata.originFamily,
    symbol: metadata.symbol || token.symbol,
  }
}

const jsonRpcRequest = async <T>(
  rpcUrl: string,
  method: string,
  params: unknown
): Promise<T> => {
  const response = await fetch(rpcUrl, {
    body: JSON.stringify({
      id: "depository-balance-audit",
      jsonrpc: "2.0",
      method,
      params,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    throw new Error(`${method} RPC request failed: ${response.status}`)
  }

  const payload = (await response.json()) as {
    error?: { message?: string }
    result?: T
  }
  if (payload.error) {
    throw new Error(payload.error.message ?? `${method} RPC request failed`)
  }
  if (payload.result == null) {
    throw new Error(`${method} RPC response is missing the result`)
  }
  return payload.result
}

const hyperliquidInfoRequest = async <T>(
  rpcUrl: string,
  body: Record<string, unknown>
): Promise<T> => {
  const response = await fetch(`${rpcUrl.replace(/\/+$/, "")}/info`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    throw new Error(`Hyperliquid info request failed: ${response.status}`)
  }
  return (await response.json()) as T
}

export const parseDecimalUnits = (value: number | string, decimals: number) => {
  const normalized = value.toString()
  const match = /^(\d+)(?:\.(\d+))?$/.exec(normalized)
  if (!match) {
    throw new Error(`Invalid decimal balance ${normalized}`)
  }

  const fraction = (match[2] ?? "").slice(0, decimals)
  return (
    BigInt(match[1]) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0")
  )
}

type LighterAccount = {
  assets?: Array<{
    asset_id: number
    balance: string
  }>
  collateral?: string
}

export const parseLighterAccountBalance = (
  account: LighterAccount,
  currency: string,
  decimals: number
) => {
  if (currency === getVmTypeNativeCurrency("lighter-vm")) {
    if (account.collateral == null) {
      throw new Error("Lighter response is missing collateral balance")
    }
    return parseDecimalUnits(account.collateral, decimals)
  }

  const asset = account.assets?.find(
    (item) => item.asset_id.toString() === currency
  )
  return asset ? parseDecimalUnits(asset.balance, decimals) : 0n
}

const toTronEvmAddress = (address: string) => {
  const encoded = encodeAddressToHex(address, "tron-vm")
  return `0x${encoded.slice(-40)}`
}

class BalanceReader {
  private ethereumProviders = new Map<string, JsonRpcProvider>()
  private solanaConnections = new Map<string, Connection>()

  async getBalance(input: BalanceInput): Promise<bigint> {
    switch (input.vmType) {
      case "bitcoin-vm":
        return this.getBitcoinBalance(input)
      case "ethereum-vm":
        return this.getEthereumBalance(input)
      case "hyperliquid-vm":
        return this.getHyperliquidBalance(input)
      case "lighter-vm":
        return this.getLighterBalance(input)
      case "solana-vm":
        return this.getSolanaBalance(input)
      case "ton-vm":
        return this.getTonBalance(input)
      case "tron-vm":
        return this.getTronBalance(input)
      case "xrp-vm":
        return this.getXrpBalance(input)
      default:
        throw new Error(`Unsupported VM type ${input.vmType}`)
    }
  }

  private async getBitcoinBalance(input: BalanceInput) {
    const result = await jsonRpcRequest<{ balance?: string }>(
      input.rpcUrl,
      "bb_getAddress",
      [
        input.depository,
        {
          details: "basic",
          fromHeight: 0,
          page: 1,
          size: 1,
        },
      ]
    )
    if (!result.balance || !/^\d+$/.test(result.balance)) {
      throw new Error("Bitcoin RPC response is missing the address balance")
    }
    return BigInt(result.balance)
  }

  private async getEthereumBalance(input: BalanceInput) {
    let provider = this.ethereumProviders.get(input.rpcUrl)
    if (!provider) {
      provider = new JsonRpcProvider(input.rpcUrl)
      this.ethereumProviders.set(input.rpcUrl, provider)
    }

    const network = await provider.getNetwork()
    if (network.chainId !== BigInt(input.chainId)) {
      throw new Error(
        `RPC chain id ${network.chainId} does not match expected chain id ${input.chainId}`
      )
    }

    const balance =
      input.currency.toLowerCase() === ZeroAddress
        ? await provider.getBalance(input.depository)
        : await new Contract(
            input.currency,
            erc20BalanceAbi,
            provider
          ).balanceOf(input.depository)

    return BigInt(balance.toString())
  }

  private async getHyperliquidBalance(input: BalanceInput) {
    if (input.currency === getVmTypeNativeCurrency("hyperliquid-vm")) {
      const state = await hyperliquidInfoRequest<{ withdrawable?: string }>(
        input.rpcUrl,
        {
          type: "clearinghouseState",
          user: input.depository,
        }
      )
      if (state.withdrawable == null) {
        throw new Error("Hyperliquid response is missing withdrawable balance")
      }
      return parseDecimalUnits(state.withdrawable, this.requireDecimals(input))
    }

    const normalizedCurrency = input.currency.toLowerCase().replace(/^0x/, "")
    if (normalizedCurrency.length < 32) {
      throw new Error(`Invalid Hyperliquid currency ${input.currency}`)
    }
    const tokenId = `0x${normalizedCurrency.slice(0, 32)}`
    const dexHex = normalizedCurrency.slice(32)
    const dex = dexHex ? Buffer.from(dexHex, "hex").toString("utf8") : undefined
    const requestSuffix = dex ? { dex } : {}
    const [meta, state] = await Promise.all([
      hyperliquidInfoRequest<{
        tokens?: Array<{
          index: number
          tokenId: string
          weiDecimals: number
        }>
      }>(input.rpcUrl, { type: "spotMeta", ...requestSuffix }),
      hyperliquidInfoRequest<{
        balances?: Array<{ token: number; total: string }>
      }>(input.rpcUrl, {
        type: "spotClearinghouseState",
        user: input.depository,
        ...requestSuffix,
      }),
    ])
    const token = meta.tokens?.find(
      (item) => item.tokenId.toLowerCase() === tokenId
    )
    if (!token) {
      throw new Error(`Hyperliquid token not found: ${tokenId}`)
    }
    const balance = state.balances?.find((item) => item.token === token.index)
    return parseDecimalUnits(
      balance?.total ?? "0",
      input.decimals ?? token.weiDecimals
    )
  }

  private async getLighterBalance(input: BalanceInput) {
    const url = new URL("/api/v1/account", input.rpcUrl)
    url.searchParams.set("by", "index")
    url.searchParams.set("value", input.depository)
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      throw new Error(`Lighter account request failed: ${response.status}`)
    }

    const payload = (await response.json()) as {
      accounts?: LighterAccount[]
    }
    const account = payload.accounts?.[0]
    if (!account) {
      throw new Error(`Lighter account not found: ${input.depository}`)
    }

    return parseLighterAccountBalance(
      account,
      input.currency,
      this.requireDecimals(input)
    )
  }

  private async getSolanaBalance(input: BalanceInput) {
    let connection = this.solanaConnections.get(input.rpcUrl)
    if (!connection) {
      connection = new Connection(input.rpcUrl, "confirmed")
      this.solanaConnections.set(input.rpcUrl, connection)
    }

    const program = new PublicKey(input.depository)
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault")],
      program
    )
    if (input.currency === getVmTypeNativeCurrency("solana-vm")) {
      return BigInt(await connection.getBalance(vault, "confirmed"))
    }

    const mint = new PublicKey(input.currency)
    const mintAccount = await connection.getAccountInfo(mint, "confirmed")
    if (!mintAccount) {
      throw new Error(`Solana mint account not found: ${input.currency}`)
    }
    const vaultTokenAccount = getAssociatedTokenAddressSync(
      mint,
      vault,
      true,
      mintAccount.owner
    )
    const balance = await connection.getTokenAccountBalance(
      vaultTokenAccount,
      "confirmed"
    )
    return BigInt(balance.value.amount)
  }

  private async getTonBalance(input: BalanceInput) {
    const balance = await jsonRpcRequest<string>(
      input.rpcUrl,
      "getAddressBalance",
      { address: input.depository }
    )
    if (!/^\d+$/.test(balance)) {
      throw new Error("TON RPC response contains an invalid account balance")
    }
    return BigInt(balance)
  }

  private async getTronBalance(input: BalanceInput) {
    const depository = toTronEvmAddress(input.depository)
    if (input.currency === getVmTypeNativeCurrency("tron-vm")) {
      const balance = await jsonRpcRequest<string>(
        input.rpcUrl,
        "eth_getBalance",
        [depository, "latest"]
      )
      return BigInt(balance)
    }

    const currency = toTronEvmAddress(input.currency)
    const data = erc20BalanceInterface.encodeFunctionData("balanceOf", [
      depository,
    ])
    const balance = await jsonRpcRequest<string>(input.rpcUrl, "eth_call", [
      { data, to: currency },
      "latest",
    ])
    return BigInt(balance)
  }

  private async getXrpBalance(input: BalanceInput) {
    const result = await jsonRpcRequest<{
      account_data?: { Balance?: string }
    }>(input.rpcUrl, "account_info", [
      {
        account: input.depository,
        ledger_index: "validated",
      },
    ])
    const balance = result.account_data?.Balance
    if (!balance || !/^\d+$/.test(balance)) {
      throw new Error("XRP RPC response is missing the account balance")
    }
    return BigInt(balance)
  }

  private requireDecimals(input: BalanceInput) {
    if (input.decimals == null) {
      throw new Error(`Token decimals are missing for ${input.currency}`)
    }
    return input.decimals
  }

  destroy() {
    for (const provider of this.ethereumProviders.values()) {
      provider.destroy()
    }
  }
}

const findOracleChain = (
  chainsById: Map<string, OracleChain>,
  token: TokenAuditRow
) => {
  const originChainId = token.origin_chain_id
  if (!originChainId) {
    return null
  }

  const configuredNetwork = networks[originChainId]
  if (configuredNetwork) {
    const chain = chainsById.get(configuredNetwork.slug)
    if (chain) {
      return { chain, network: configuredNetwork }
    }
  }

  for (const chain of chainsById.values()) {
    const network = networks[chain.id]
    const derivedChainId =
      network?.chainId.toString() ?? BigInt(id(chain.id)).toString()
    if (derivedChainId === originChainId) {
      return { chain, network }
    }

    if (token.origin_family && token.origin_asset) {
      try {
        const tokenId = generateTokenId({
          address: token.origin_asset,
          chainId: chain.id,
          family: token.origin_family as VmType,
        })
        if (tokenId.toString() === token.token_id) {
          return { chain, network }
        }
      } catch {
        // Continue checking chains when the currency cannot be encoded.
      }
    }
  }

  return null
}

const resultFor = (
  token: TokenAuditRow,
  totalSupply: bigint | null,
  values: Partial<DepositoryBalanceAuditResult> & {
    status: DepositoryBalanceAuditStatus
  }
): DepositoryBalanceAuditResult => {
  const result: DepositoryBalanceAuditResult = {
    chainId: null,
    currency: token.origin_asset,
    decimals: token.decimals,
    delta: null,
    deltaFormatted: null,
    depository: null,
    depositoryBalance: null,
    depositoryBalanceFormatted: null,
    error: null,
    tokenId: token.token_id,
    tokenName: token.name,
    tokenSymbol: token.symbol,
    totalSupply: totalSupply?.toString() ?? null,
    totalSupplyFormatted: null,
    vmType: token.origin_family,
    ...values,
  }

  return {
    ...result,
    deltaFormatted: formatAuditAmount(result.delta, result.decimals),
    depositoryBalanceFormatted: formatAuditAmount(
      result.depositoryBalance,
      result.decimals
    ),
    totalSupplyFormatted: formatAuditAmount(
      result.totalSupply,
      result.decimals
    ),
  }
}

export const runDepositoryBalanceAudit = async (
  db: Queryable,
  hubContract: Contract,
  options: RunOptions = {}
) => {
  const reader = options.getBalance ? null : new BalanceReader()
  const getBalance =
    options.getBalance ?? ((input: BalanceInput) => reader!.getBalance(input))
  const results: DepositoryBalanceAuditResult[] = []

  try {
    if (!options.fetchChains && !options.oracleApiUrl) {
      throw new Error("Oracle API URL is required")
    }
    const chains = options.fetchChains
      ? await options.fetchChains()
      : await fetchOracleChains(
          options.oracleApiUrl as string,
          options.oracleApiKey
        )
    const chainsById = new Map(chains.map((chain) => [chain.id, chain]))
    const tokens = await db.manyOrNone<TokenAuditRow>(
      `SELECT token_id, name, symbol, decimals, origin_family,
              origin_chain_id, origin_asset
       FROM tokens
       ORDER BY token_id ASC`
    )

    for (const originalToken of tokens) {
      let token = originalToken

      try {
        const tokenWithOriginMetadata = await ensureTokenOriginMetadata(
          db,
          hubContract,
          token
        )
        if (!tokenWithOriginMetadata) {
          results.push(
            resultFor(token, null, {
              status: "unsupported",
            })
          )
          continue
        }
        token = tokenWithOriginMetadata
      } catch (error) {
        results.push(
          resultFor(token, null, {
            error: errorMessage(error),
            status: "error",
          })
        )
        continue
      }

      if (
        !token.origin_family ||
        !SUPPORTED_VM_TYPES.has(token.origin_family)
      ) {
        results.push(
          resultFor(token, null, {
            error: `Unsupported origin family ${token.origin_family}`,
            status: "unsupported",
          })
        )
        continue
      }

      const resolved = findOracleChain(chainsById, token)
      if (!resolved) {
        results.push(
          resultFor(token, null, {
            error: `Oracle chain not found for origin chain ${token.origin_chain_id}`,
            status: "unsupported",
          })
        )
        continue
      }

      const { chain, network } = resolved
      const rpcEnvName = rpcEnvNameForChain(chain.id)
      const rpcUrl = (options.env ?? process.env)[rpcEnvName]
      const resultBase = {
        chainId: chain.id,
        depository: chain.depository,
        vmType: chain.vmType,
      }

      if (
        chain.vmType !== token.origin_family ||
        (network && network.family !== token.origin_family)
      ) {
        results.push(
          resultFor(token, null, {
            ...resultBase,
            error: `Chain ${chain.id} VM type does not match token origin family ${token.origin_family}`,
            status: "error",
          })
        )
        continue
      }

      if (!rpcUrl) {
        results.push(
          resultFor(token, null, {
            ...resultBase,
            error: `Missing required env var ${rpcEnvName}`,
            status: "error",
          })
        )
        continue
      }

      if (
        NATIVE_ONLY_VM_TYPES.has(token.origin_family) &&
        token.origin_asset !==
          getVmTypeNativeCurrency(token.origin_family as VmType)
      ) {
        results.push(
          resultFor(token, null, {
            ...resultBase,
            status: "unsupported",
          })
        )
        continue
      }

      try {
        const [balance, totalSupplyResult] = await Promise.all([
          getBalance({
            chainId: token.origin_chain_id as string,
            currency: token.origin_asset as string,
            decimals: token.decimals,
            depository: chain.depository,
            rpcUrl,
            vmType: token.origin_family as string,
          }),
          hubContract.totalSupply(token.token_id),
        ])
        const totalSupply = BigInt(totalSupplyResult.toString())
        const status = classifyDepositoryBalance(balance, totalSupply)
        results.push(
          resultFor(token, totalSupply, {
            ...resultBase,
            delta: (balance - totalSupply).toString(),
            depositoryBalance: balance.toString(),
            status,
          })
        )
      } catch (error) {
        results.push(
          resultFor(token, null, {
            ...resultBase,
            error: errorMessage(error),
            status: "error",
          })
        )
      }
    }

    return {
      checked: results.filter(
        (result) => result.status === "covered" || result.status === "deficit"
      ).length,
      covered: results.filter((result) => result.status === "covered").length,
      deficit: results.filter((result) => result.status === "deficit").length,
      error: results.filter((result) => result.status === "error").length,
      results,
      unsupported: results.filter((result) => result.status === "unsupported")
        .length,
    }
  } finally {
    reader?.destroy()
  }
}
