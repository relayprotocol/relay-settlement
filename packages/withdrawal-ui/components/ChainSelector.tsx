"use client"

import { ChainIcon } from "./ChainTokenIcon"
import { Dropdown } from "./Dropdown"
import type { ChainInfo } from "@/lib/core/withdrawal/chains"

interface ChainSelectorProps {
  chains: ChainInfo[]
  selected: ChainInfo | null
  onSelect: (chain: ChainInfo) => void
  label?: string
}

export function ChainSelector({
  chains,
  selected,
  onSelect,
  label = "Chain",
}: ChainSelectorProps) {
  return (
    <div>
      <label className="text-sm text-subtle block mb-1">{label}</label>
      <Dropdown
        searchPlaceholder="Search chains..."
        trigger={
          <button className="input w-full flex items-center gap-2 text-left">
            {selected ? (
              <>
                <ChainIcon chainId={selected.id} size={20} />
                <span>{selected.displayName}</span>
              </>
            ) : (
              <span className="text-gray-400">Select chain</span>
            )}
            <span className="ml-auto text-gray-400">&#9662;</span>
          </button>
        }
        items={chains.map((chain) => ({
          key: String(chain.id),
          icon: <ChainIcon chainId={chain.id} size={20} />,
          label: chain.displayName,
          onClick: () => onSelect(chain),
        }))}
      />
    </div>
  )
}

/** Shared loading/error UI for chain data */
export function ChainsLoadingState({
  loading,
  error,
  retry,
}: {
  loading: boolean
  error: boolean
  retry: () => void
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-3 py-4">
        <div className="spinner" />
        <span className="text-subtle text-sm">Loading chains...</span>
      </div>
    )
  }
  if (error) {
    return (
      <div className="py-4 text-center">
        <p className="text-sm text-error mb-3">Failed to load chains</p>
        <button className="btn-secondary btn-sm" onClick={retry}>
          Retry
        </button>
      </div>
    )
  }
  return null
}
