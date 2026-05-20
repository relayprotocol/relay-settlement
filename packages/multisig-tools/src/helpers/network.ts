import { networks } from "@relay-protocol/settlement-networks"
import { createPublicClient, createWalletClient, defineChain, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import * as viemChains from "viem/chains"

export interface ResolvedNetwork {
  chainId: number
  slug: string
  rpc: string
  multisigSignerAddress: `0x${string}`
  // Typed loosely because viem narrows clients by chain and the static
  // chain list here is too wide for a single concrete client type.
  publicClient: any
  walletClient: any
}

export interface ResolveNetworkOptions {
  network?: string
  rpcOverride?: string
  multisigSignerOverride?: `0x${string}`
  env?: "prod" | "dev" | "stag"
}

const findNetworkConfig = (slug: string) => {
  const config = networks[slug]
  if (config && config.slug === slug) return config

  for (const candidate of Object.values(networks)) {
    if (candidate.slug === slug) return candidate
    if (String(candidate.chainId) === slug) return candidate
  }
  return undefined
}

const findViemChain = (chainId: number) => {
  for (const chain of Object.values(viemChains)) {
    if ((chain as { id?: number }).id === chainId)
      return chain as (typeof viemChains)[keyof typeof viemChains]
  }
  return undefined
}

const requireDeployerKey = () => {
  const key = process.env.DEPLOYER_PRIVATE_KEY ?? process.env.PRIVATE_KEY
  if (!key) {
    throw new Error(
      "Set DEPLOYER_PRIVATE_KEY (or PRIVATE_KEY) in the environment."
    )
  }
  return (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`
}

export function resolveNetwork(
  opts: ResolveNetworkOptions = {}
): ResolvedNetwork {
  const envOverride = (process.env.MULTISIG_NETWORK || process.env.NETWORK) as
    | string
    | undefined
  const slug = opts.network ?? envOverride

  let config = slug ? findNetworkConfig(slug) : undefined
  let chainId = config ? Number(config.chainId) : undefined

  if (process.env.CHAIN_ID && !chainId) {
    chainId = Number(process.env.CHAIN_ID)
    if (!config) config = findNetworkConfig(String(chainId))
  }

  if (!chainId) {
    throw new Error(
      "resolveNetwork: pass --network <slug>, or set CHAIN_ID/MULTISIG_NETWORK in the environment."
    )
  }

  const rpc = opts.rpcOverride ?? process.env.RPC_URL ?? config?.rpc?.[0]
  if (!rpc) {
    throw new Error(
      `resolveNetwork: no RPC URL for chain ${chainId}. Pass --rpc-url or set RPC_URL.`
    )
  }

  const env = opts.env ?? "prod"
  const multisigSignerAddress = (opts.multisigSignerOverride ??
    (process.env.RELAY_MULTISIG_SIGNER as `0x${string}` | undefined) ??
    (config?.contracts?.[env]?.multisigSigner as `0x${string}` | undefined) ??
    (config?.contracts?.dev?.multisigSigner as `0x${string}` | undefined)) as
    | `0x${string}`
    | undefined

  if (!multisigSignerAddress) {
    throw new Error(
      `resolveNetwork: no multisigSigner address found for ${config?.slug ?? chainId}. Pass --relay-multisig-signer or set RELAY_MULTISIG_SIGNER.`
    )
  }

  const knownChain = findViemChain(chainId)
  const chain =
    knownChain ??
    defineChain({
      id: chainId,
      name: config?.name ?? `chain-${chainId}`,
      nativeCurrency: config?.nativeCurrency ?? {
        decimals: 18,
        name: "ETH",
        symbol: "ETH",
      },
      rpcUrls: {
        default: { http: [rpc] },
        public: { http: [rpc] },
      },
    })

  const transport = http(rpc)
  const account = privateKeyToAccount(requireDeployerKey())

  return {
    chainId,
    multisigSignerAddress,
    publicClient: createPublicClient({ chain, transport }),
    rpc,
    slug: config?.slug ?? `chain-${chainId}`,
    walletClient: createWalletClient({ account, chain, transport }),
  }
}
