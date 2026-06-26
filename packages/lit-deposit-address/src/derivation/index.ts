import { assertVmType } from "../common/vm.js";
import {
  VM_TYPES,
  type AccountInfo,
  type DepositAddressTrigger,
  type DepositAddressTriggerAttestation,
  type VmSignedTransactionMap,
  type VmTransactionMap,
  type VmType,
  type WalletInfo,
} from "../common/types.js";
import type { VmWalletDeriver } from "./vm/base/VmWalletDeriver.js";
import { BitcoinVmWalletDeriver } from "./vm/bitcoin/BitcoinVmWalletDeriver.js";
import { EthereumVmWalletDeriver } from "./vm/ethereum/EthereumVmWalletDeriver.js";
import { HyperliquidVmWalletDeriver } from "./vm/hyperliquid/HyperliquidVmWalletDeriver.js";
import { SolanaVmWalletDeriver } from "./vm/solana/SolanaVmWalletDeriver.js";
import { TonVmWalletDeriver } from "./vm/ton/TonVmWalletDeriver.js";

/**
 * Public package entrypoint. Re-exports everything off-TEE consumers need
 * (derivation API + path computation + types).
 */
export * from "../common/types.js";
export * from "./path.js";

/** A VM deriver typed against its concrete transaction inputs/outputs. */
type TypedVmWalletDeriver<V extends VmType> = VmWalletDeriver<
  VmTransactionMap[V],
  VmSignedTransactionMap[V]
>;

/** Registry of VM-specific wallet derivers, keyed by VM family. */
const VM_DERIVERS = {
  "ethereum-vm": new EthereumVmWalletDeriver(),
  "bitcoin-vm": new BitcoinVmWalletDeriver(),
  "solana-vm": new SolanaVmWalletDeriver(),
  "hyperliquid-vm": new HyperliquidVmWalletDeriver(),
  "ton-vm": new TonVmWalletDeriver(),
} satisfies { [V in VmType]: TypedVmWalletDeriver<V> };

function getDeriver<V extends VmType>(vmType: V): TypedVmWalletDeriver<V> {
  return VM_DERIVERS[vmType] as unknown as TypedVmWalletDeriver<V>;
}

/** List every VM family supported by this build. */
export function getSupportedVmTypes(): VmType[] {
  return [...VM_TYPES];
}

/** Derive the publicly shareable account root for a VM from the PKP root key. */
export function deriveAccount(rootKeyHex: string, vmType: VmType): Promise<AccountInfo> {
  return getDeriver(vmType).deriveAccount(rootKeyHex);
}

/** Derive a child wallet at the given derivation path from the PKP root key. */
export function deriveWallet(
  rootKeyHex: string,
  vmType: VmType,
  indexes: readonly number[],
): Promise<WalletInfo> {
  return getDeriver(vmType).deriveWallet(rootKeyHex, indexes);
}

/**
 * Derive a child wallet at the given derivation path from an account-level
 * extended public key. Produces the same address as {@link deriveWallet}
 * without requiring access to the root private key.
 */
export function deriveWalletFromExtendedPublicKey(
  vmType: VmType,
  extendedPublicKey: string,
  indexes: readonly number[],
): Promise<WalletInfo> {
  return getDeriver(vmType).deriveWalletFromExtendedPublicKey(extendedPublicKey, indexes);
}

/**
 * Sign one or more VM-native transactions with the child wallet at the given
 * derivation path. The wallet's private key is derived once and reused for all
 * transactions.
 */
export function signTransactionsWithWallet<V extends VmType>(
  rootKeyHex: string,
  vmType: V,
  indexes: readonly number[],
  transactions: readonly VmTransactionMap[V][],
): Promise<{ wallet: WalletInfo; signedTransactions: VmSignedTransactionMap[V][] }> {
  return getDeriver(vmType).signTransactions(rootKeyHex, indexes, transactions);
}

/**
 * Run the VM-specific transaction policy check on a batch of unsigned
 * VM-native transactions. Throws if any transaction violates the deposit
 * shape expected by the VM-specific deriver.
 */
export function verifyTransactionsWithWallet(
  trigger: DepositAddressTrigger,
  attestation: DepositAddressTriggerAttestation,
  transactions: readonly VmTransactionMap[VmType][],
): void {
  const vmType = assertVmType(
    trigger.derivationFields.inputVmType,
    "trigger.derivationFields.inputVmType",
  );
  // Per-VM `verifyTransactions` overrides narrow `transactions` to their own
  // concrete shape; the runtime dispatch on `vmType` keeps that contract.
  getDeriver(vmType).verifyTransactions(
    trigger,
    attestation,
    transactions as readonly VmTransactionMap[typeof vmType][],
  );
}
