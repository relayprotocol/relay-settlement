import type { Address, PublicClient } from "viem"
import {
  generateTokenId,
  generateAddress,
} from "@relay-protocol/settlement-sdk"
import type { VmType } from "@relay-protocol/settlement-sdk"
import { RelayHubAbi } from "@/lib/abis"

/** Map solver vmType shortcodes to SDK VmType */
const VM_TYPE_MAP: Record<string, VmType> = {
  evm: "ethereum-vm",
  svm: "solana-vm",
  bvm: "bitcoin-vm",
  tvm: "tron-vm",
  hypevm: "hyperliquid-vm",
  suivm: "sui-vm",
  tonvm: "ton-vm",
}

function toSdkVmType(solverVmType: string): VmType {
  return VM_TYPE_MAP[solverVmType] ?? "ethereum-vm"
}

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
