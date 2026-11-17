import { useQuery } from "@tanstack/react-query"
import { indexerQueries } from "./api/queries"
import type { DepositoryTokenState, VmType } from "./api/schema"
import { formatChainName } from "./utils"

const NATIVE_ASSET = /^(0x)?0+$|^1+$|^bc1q+mql8k8$/

export const isNativeAsset = (asset: string) => NATIVE_ASSET.test(asset)

const VM_LABELS: Record<VmType, string> = {
  "ethereum-vm": "EVM",
  "solana-vm": "SVM",
  "bitcoin-vm": "Bitcoin",
  "tron-vm": "Tron",
  "ton-vm": "TON",
  "xrp-vm": "XRP",
  "hyperliquid-vm": "Hyperliquid",
  "lighter-vm": "Lighter",
  "hedera-vm": "Hedera",
  "gateway-vm": "Gateway",
}

const VM_ORDER = Object.keys(VM_LABELS)

export const vmLabel = (vm: VmType) => VM_LABELS[vm]

export const vmOrder = (vm: VmType) => VM_ORDER.indexOf(vm)

export const chainPath = (chain: string, gateway = false) =>
  `/chains/${chain}${gateway ? "/gateway" : ""}`

export const useOriginChains = () => {
  const { data: config, error } = useQuery(indexerQueries.config())
  const status = useQuery(indexerQueries.status()).data
  const statuses = new Map(status?.chains.map((chain) => [chain.chain, chain]))
  const chains = config?.chains
    .filter((chain) => chain.depositories.length)
    .map((chain) => ({
      ...chain,
      depository: chain.depositories[0] ?? "",
      label: formatChainName(chain.name),
      status: statuses.get(chain.chain),
    }))
  return { chains, error }
}

export type OriginChain = NonNullable<
  ReturnType<typeof useOriginChains>["chains"]
>[number]

const assetKey = (asset: string, vm: VmType) =>
  vm === "ethereum-vm" ? asset.toLowerCase() : asset

const supplied = (state: DepositoryTokenState) =>
  BigInt(state.total_supply ?? 0) > 0n

export const representativeStates = (
  states: DepositoryTokenState[],
  vm: VmType
) => {
  const byAsset = new Map<string, DepositoryTokenState>()
  for (const state of states) {
    const asset = state.target.origin_asset
    if (!asset) continue
    const current = byAsset.get(assetKey(asset, vm))
    if (!current || (!supplied(current) && supplied(state)))
      byAsset.set(assetKey(asset, vm), state)
  }
  return byAsset
}

export const assetStates = (states: DepositoryTokenState[], vm: VmType) => {
  const byAsset = representativeStates(states, vm)
  const native = [...byAsset.values()].find(
    (state) =>
      state.target.origin_asset && isNativeAsset(state.target.origin_asset)
  )
  return (token?: string | null) =>
    token ? byAsset.get(assetKey(token, vm)) : native
}
