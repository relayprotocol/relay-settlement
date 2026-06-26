import {
  recoverPersonalSignAddress,
  verifyDepositAddressTriggerAttestation,
  verifyOrderData,
} from "../attestation/index.js";
import { bytesToHex } from "../common/bytes.js";
import { keccak256 } from "../common/crypto.js";
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
  /** EIP-191 signature by `order.solver` over the canonical sign request hash. */
  requestSignature?: string;
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
    const { trigger, attestation, order, orderSignature, requestSignature, transactions } = params;
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
    if (!requestSignature) {
      throw new Error("requestSignature is required for action=sign");
    }
    if (!Array.isArray(transactions) || transactions.length === 0) {
      throw new Error("at least one transaction is required for action=sign");
    }
    assertVm(trigger.input.vmType, vmType, "trigger.input.vmType");
    assertVm(trigger.derivationFields.inputVmType, vmType, "trigger.derivationFields.inputVmType");
    verifySolverRequestSignature(params, order, requestSignature);

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

/**
 * Verify the EIP-191 `requestSignature` over the canonical sign request body
 * (excluding the signature field itself). The signature must recover to
 * `order.solver`. This protects the PKP from being used to sign sweeps when
 * only the usage API key is compromised: a caller must additionally hold the
 * solver EOA key to produce a valid request signature.
 */
export function verifySolverRequestSignature<V extends VmType>(
  params: ActionParams<V>,
  order: Order,
  signature: string,
): void {
  const requestHash = solverSignRequestHash(params as unknown as Record<string, unknown>);
  const recovered = recoverPersonalSignAddress(requestHash, signature as `0x${string}`);
  if (recovered.toLowerCase() !== order.solver.toLowerCase()) {
    throw new Error(
      `requestSignature mismatch: recovered=${recovered}, order.solver=${order.solver}`,
    );
  }
}

/**
 * Compute the keccak256 hash of the canonical JSON encoding of a sign request,
 * with the `requestSignature` field stripped at every nesting level. Callers
 * sign this hash with EIP-191 personal_sign so the action can verify the
 * request was authorized by the solver EOA.
 */
export function solverSignRequestHash(params: Record<string, unknown>): `0x${string}` {
  const unsigned = stripSolverRequestSignature(params);
  const bytes = new TextEncoder().encode(canonicalJson(unsigned));
  return `0x${bytesToHex(keccak256(bytes))}`;
}

/**
 * Recursively remove every `requestSignature` field from a value tree. Used
 * to build the canonical pre-signature representation that
 * {@link solverSignRequestHash} hashes.
 */
function stripSolverRequestSignature(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripSolverRequestSignature);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "requestSignature") {
        continue;
      }
      out[key] = stripSolverRequestSignature(child);
    }
    return out;
  }
  return value;
}

/**
 * Serialize a JSON-compatible value with deterministic key ordering at every
 * nesting level. Object keys are emitted in lexicographic order so signers
 * and verifiers produce the same byte representation regardless of how their
 * input objects were constructed.
 *
 * `undefined`-valued object entries are dropped to mirror `JSON.stringify`
 * semantics, which omits them from the encoded output. Without this, a
 * caller building `ActionParams` with an explicit `field: undefined` would
 * hash a body that doesn't match the JSON the action receives over the
 * wire, surfacing as a confusing `requestSignature mismatch` error.
 */
function canonicalJson(value: unknown): string {
  if (value === undefined) {
    return "null";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((key) => obj[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`)
    .join(",")}}`;
}
