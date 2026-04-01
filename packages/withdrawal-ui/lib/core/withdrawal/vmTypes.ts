import type { VmType } from "@relay-protocol/settlement-sdk"

interface VmConfig {
  displayName: string
  dynamicChain: string
  sdkFamily: VmType
  /** Explorer tx path suffix — appended after base URL. Use `{hash}` placeholder. */
  explorerTxPath: string
  /** Whether this VM uses wagmi (EVM-compatible RPC) for wallet connection */
  wagmiCompatible: boolean
}

/** Centralized VM type configuration — single source of truth for all VM type mappings */
export const VM_CONFIG: Record<string, VmConfig> = {
  evm: {
    displayName: "EVM",
    dynamicChain: "EVM",
    sdkFamily: "ethereum-vm",
    explorerTxPath: "/tx/{hash}",
    wagmiCompatible: true,
  },
  hypevm: {
    displayName: "Hyperliquid",
    dynamicChain: "EVM",
    sdkFamily: "hyperliquid-vm",
    explorerTxPath: "/tx/{hash}",
    wagmiCompatible: true,
  },
  svm: {
    displayName: "Solana",
    dynamicChain: "SOL",
    sdkFamily: "solana-vm",
    explorerTxPath: "/tx/{hash}",
    wagmiCompatible: false,
  },
  bvm: {
    displayName: "Bitcoin",
    dynamicChain: "BTC",
    sdkFamily: "bitcoin-vm",
    explorerTxPath: "/tx/{hash}",
    wagmiCompatible: false,
  },
  tvm: {
    displayName: "Tron",
    dynamicChain: "TRON",
    sdkFamily: "tron-vm",
    explorerTxPath: "/#/transaction/{hash}",
    wagmiCompatible: false,
  },
  suivm: {
    displayName: "Sui",
    dynamicChain: "SUI",
    sdkFamily: "sui-vm",
    explorerTxPath: "/txblock/{hash}",
    wagmiCompatible: false,
  },
  tonvm: {
    displayName: "TON",
    dynamicChain: "TON",
    sdkFamily: "ton-vm",
    explorerTxPath: "/tx/{hash}",
    wagmiCompatible: false,
  },
}

export const SUPPORTED_WITHDRAWAL_VM_TYPES = [
  "evm",
  "svm",
  "bvm",
  "hypevm",
  // "tvm"   — protocol not yet enabled, reserved for future
  // "suivm" — protocol not yet enabled, reserved for future
] as const

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

/** Whether a tx hash is a real on-chain identifier (not a synthetic placeholder) */
export function isRealTxHash(txHash: string | undefined): boolean {
  return txHash != null && !txHash.startsWith("hype-nonce-")
}

/** Whether this VM type should be included in wagmi config (EVM-compatible RPC) */
export function isWagmiCompatible(solverVmType: string): boolean {
  return VM_CONFIG[solverVmType]?.wagmiCompatible ?? false
}

/** Build full explorer tx URL from base URL, tx hash, and VM type */
export function getExplorerTxUrl(
  explorerUrl: string,
  txHash: string,
  solverVmType: string
): string {
  const base = explorerUrl.replace(/\/+$/, "")
  const pathTemplate = VM_CONFIG[solverVmType]?.explorerTxPath ?? "/tx/{hash}"
  return base + pathTemplate.replace("{hash}", txHash)
}
