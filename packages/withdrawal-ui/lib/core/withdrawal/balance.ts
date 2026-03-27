import type { Address, PublicClient } from "viem"
import {
  generateTokenId,
  generateAddress,
} from "@relay-protocol/settlement-sdk"
import { RelayHubAbi } from "@/lib/abis"
import { toSdkVmType } from "./vmTypes"

const ERC20_DECIMALS_ABI = [
  {
    inputs: [],
    name: "decimals",
    outputs: [{ type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const

/**
 * Read user's hub balance for a specific token.
 *
 * IMPORTANT: chainId params must be chain SLUGS (e.g. "ethereum", "base"),
 * not numeric IDs ("1", "8453"). The oracle uses slugs when computing
 * virtual addresses via generateAddress/generateTokenId.
 */
export async function getHubBalance(
  hubClient: PublicClient,
  hubAddress: Address,
  params: {
    chainSlug: string // e.g. "ethereum", "base" — NOT "1", "8453"
    currency: string
    owner: string
    ownerChainSlug: string // e.g. "ethereum" — NOT "1"
    vmType?: string // solver vmType shortcode, e.g. "evm"
  }
): Promise<bigint> {
  const family = toSdkVmType(params.vmType ?? "evm")

  const virtualAddress = generateAddress({
    family,
    chainId: params.ownerChainSlug,
    address: params.owner,
  })

  const tokenId = generateTokenId({
    family,
    chainId: params.chainSlug,
    address: params.currency,
  })

  return hubClient.readContract({
    address: hubAddress,
    abi: RelayHubAbi,
    functionName: "balanceOf",
    args: [virtualAddress, tokenId],
  }) as Promise<bigint>
}

/**
 * Read hub balances for multiple currencies in parallel.
 * Returns a map of currency address → balance.
 */
export async function getHubBalances(
  hubClient: PublicClient,
  hubAddress: Address,
  params: {
    chainSlug: string
    currencies: string[]
    owner: string
    ownerChainSlug: string
    vmType?: string
  }
): Promise<Record<string, bigint>> {
  const family = toSdkVmType(params.vmType ?? "evm")

  const virtualAddress = generateAddress({
    family,
    chainId: params.ownerChainSlug,
    address: params.owner,
  })

  const results = await Promise.allSettled(
    params.currencies.map(
      (currency) =>
        hubClient.readContract({
          address: hubAddress,
          abi: RelayHubAbi,
          functionName: "balanceOf",
          args: [
            virtualAddress,
            generateTokenId({
              family,
              chainId: params.chainSlug,
              address: currency,
            }),
          ],
        }) as Promise<bigint>
    )
  )

  const balances: Record<string, bigint> = {}
  for (let i = 0; i < params.currencies.length; i++) {
    const result = results[i]
    balances[params.currencies[i]] =
      result.status === "fulfilled" ? result.value : 0n
  }
  return balances
}

/**
 * Get token decimals from ERC20 contract on the withdrawal chain.
 * For native currency (address(0) or similar), returns 18.
 */
export async function getTokenDecimals(
  client: PublicClient,
  currency: Address
): Promise<number> {
  const NATIVE = "0x0000000000000000000000000000000000000000" as Address
  if (currency.toLowerCase() === NATIVE.toLowerCase()) return 18

  const result = await client.readContract({
    address: currency,
    abi: ERC20_DECIMALS_ABI,
    functionName: "decimals",
  })
  return Number(result)
}
