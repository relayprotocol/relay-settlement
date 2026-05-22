import { verifyDepositAddressTriggerAttestation, verifyOrderData } from "../attestation/index.js";
import type {
  AccountInfo,
  DepositAddressTrigger,
  DepositAddressTriggerAttestation,
  DepositAddressTriggerDerivationFields,
  Order,
  VmSignedTransactionMap,
  VmTransactionMap,
  VmType,
  WalletInfo,
} from "../common/types.js";
import { derivationFieldsToIndexes } from "../derivation/path.js";
import type { VmWalletDeriver } from "../derivation/vm/base/VmWalletDeriver.js";

/** `jsParams` accepted by every per-VM Lit Action entrypoint. */
export interface ActionParams<V extends VmType> {
  pkpId: string;
  action: "account" | "wallet" | "sign" | string;
  /** Required for action="account"; must equal the bundle's VM. */
  vmType?: string;
  /** Required for action="wallet" and embedded in `trigger` for action="sign". */
  derivationFields?: DepositAddressTriggerDerivationFields;
  /** Required for action="sign". */
  trigger?: DepositAddressTrigger;
  attestation?: DepositAddressTriggerAttestation;
  order?: Order;
  orderSignature?: string;
  transactions?: VmTransactionMap[V][];
}

/** Result returned by the `sign` action. */
export interface SignResult<V extends VmType> {
  wallet: WalletInfo;
  triggerHash: string;
  signedTransactions: VmSignedTransactionMap[V][];
}

/**
 * Run a per-VM Lit Action entrypoint pinned to `vmType`. Dispatches on
 * `params.action` and enforces VM-bundle invariants on every input
 * (`vmType`, `derivationFields.inputVmType`, `trigger.input.vmType`,
 * `trigger.derivationFields.inputVmType`).
 */
export async function runVmAction<V extends VmType>(
  vmType: V,
  deriver: VmWalletDeriver<VmTransactionMap[V], VmSignedTransactionMap[V]>,
  params: ActionParams<V>,
): Promise<AccountInfo | WalletInfo | SignResult<V>> {
  const rootKeyHex = await Lit.Actions.getPrivateKey({ pkpId: params.pkpId });

  if (params.action === "account") {
    assertVm(params.vmType, vmType, "vmType");
    return deriver.deriveAccount(rootKeyHex);
  }

  if (params.action === "wallet") {
    const { derivationFields } = params;
    if (!derivationFields) {
      throw new Error("derivationFields is required for action=wallet");
    }
    assertVm(derivationFields.inputVmType, vmType, "derivationFields.inputVmType");
    return deriver.deriveWallet(rootKeyHex, derivationFieldsToIndexes(derivationFields));
  }

  if (params.action === "sign") {
    const { trigger, attestation, order, orderSignature, transactions } = params;
    if (!trigger) {
      throw new Error("trigger is required for action=sign");
    }
    if (!attestation) {
      throw new Error("attestation is required for action=sign");
    }
    if (!order) {
      throw new Error("order is required for action=sign");
    }
    if (!orderSignature) {
      throw new Error("orderSignature is required for action=sign");
    }
    if (!Array.isArray(transactions) || transactions.length === 0) {
      throw new Error("at least one transaction is required for action=sign");
    }
    assertVm(trigger.input.vmType, vmType, "trigger.input.vmType");
    assertVm(trigger.derivationFields.inputVmType, vmType, "trigger.derivationFields.inputVmType");

    await verifyDepositAddressTriggerAttestation(trigger, attestation);
    verifyOrderData(trigger, order, orderSignature);
    deriver.verifyTransactions(trigger, attestation, transactions);

    const { wallet, signedTransactions } = await deriver.signTransactions(
      rootKeyHex,
      derivationFieldsToIndexes(trigger.derivationFields),
      transactions,
    );
    return { wallet, triggerHash: attestation.triggerHash, signedTransactions };
  }

  throw new Error(`unknown action: ${String(params.action)}`);
}

function assertVm(actual: string | undefined, expected: VmType, field: string): void {
  if (actual !== expected) {
    throw new Error(`${field} must be "${expected}" for this action bundle (got ${actual})`);
  }
}
