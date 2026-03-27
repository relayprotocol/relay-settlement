import type { VmType } from "@relay-protocol/settlement-sdk"

interface VmConfig {
  displayName: string
  dynamicChain: string
  sdkFamily: VmType
}

/** Centralized VM type configuration — single source of truth for all VM type mappings */
export const VM_CONFIG: Record<string, VmConfig> = {
  evm: { displayName: "EVM", dynamicChain: "EVM", sdkFamily: "ethereum-vm" },
  hypevm: {
    displayName: "Hyperliquid",
    dynamicChain: "EVM",
    sdkFamily: "hyperliquid-vm",
  },
  svm: { displayName: "Solana", dynamicChain: "SOL", sdkFamily: "solana-vm" },
  bvm: { displayName: "Bitcoin", dynamicChain: "BTC", sdkFamily: "bitcoin-vm" },
  tvm: { displayName: "Tron", dynamicChain: "TRON", sdkFamily: "tron-vm" },
  suivm: { displayName: "Sui", dynamicChain: "SUI", sdkFamily: "sui-vm" },
  tonvm: { displayName: "TON", dynamicChain: "TON", sdkFamily: "ton-vm" },
}

export const SUPPORTED_WITHDRAWAL_VM_TYPES = ["evm"] as const

/** Get SDK VmType from solver vmType shortcode */
export function toSdkVmType(solverVmType: string): VmType {
  return VM_CONFIG[solverVmType]?.sdkFamily ?? "ethereum-vm"
}

export function isWithdrawalVmSupported(solverVmType: string): boolean {
  return SUPPORTED_WITHDRAWAL_VM_TYPES.includes(
    solverVmType as (typeof SUPPORTED_WITHDRAWAL_VM_TYPES)[number]
  )
}

/** Get Dynamic wallet chain identifier from solver vmType */
export function toDynamicChain(solverVmType: string): string | undefined {
  return VM_CONFIG[solverVmType]?.dynamicChain
}

/** Get display name for a solver vmType */
export function getVmDisplayName(solverVmType: string): string {
  return VM_CONFIG[solverVmType]?.displayName ?? solverVmType
}
