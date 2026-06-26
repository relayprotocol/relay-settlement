import {
  encodeAbiParameters,
  keccak256,
  type Address,
  type Hex,
} from "https://cdn.jsdelivr.net/npm/viem@2.48.11/+esm";
import type { DepositAddressTriggerDerivationFields } from "../common/types.js";

/**
 * ABI schema used to encode {@link DepositAddressTriggerDerivationFields} for
 * hashing. The encoding is fixed and must be kept in sync with the oracle's
 * trigger-hash construction so off-chain and on-chain consumers agree on the
 * derivation path computed from a trigger.
 */
const DERIVATION_FIELDS_ABI = [
  {
    type: "tuple",
    components: [
      { name: "inputVmType", type: "string" },
      { name: "outputVmType", type: "string" },
      { name: "outputChainId", type: "string" },
      { name: "outputCurrency", type: "bytes" },
      { name: "outputRecipient", type: "bytes" },
      { name: "solver", type: "address" },
      { name: "pricingOracle", type: "address" },
      { name: "depositor", type: "bytes" },
      { name: "refundRecipient", type: "bytes" },
      { name: "priceImpactBps", type: "uint256" },
    ],
  },
] as const;

/** Number of unhardened child segments produced from one derivation-fields hash. */
const PATH_SEGMENTS = 8;

/** Highest valid unhardened uint31 child index (`2^31 - 1`). */
const UINT31_MASK = 0x7fff_ffff;

/**
 * Split a 32-byte hex hash into `PATH_SEGMENTS` unhardened uint31 indexes, one
 * per 4-byte word. The top bit of each word is cleared so that every segment
 * is a valid unhardened BIP32/CIP3 index.
 */
function bytes32ToIndexes(hash: string): number[] {
  const hex = hash.startsWith("0x") ? hash.slice(2) : hash;
  return Array.from({ length: PATH_SEGMENTS }, (_, i) => {
    return Number.parseInt(hex.slice(i * 8, i * 8 + 8), 16) & UINT31_MASK;
  });
}

/**
 * Map `derivationFields` to a deterministic eight-segment unhardened child path.
 *
 * `keccak256(abi.encode((derivationFields)))` is split into eight 32-bit words,
 * each masked to its low 31 bits. That gives 8 * 31 = 248 bits of effective
 * collision resistance while keeping every segment publicly derivable from the
 * account-level extended public key.
 */
export function derivationFieldsToIndexes(
  derivationFields: DepositAddressTriggerDerivationFields,
): number[] {
  const encoded = encodeAbiParameters(DERIVATION_FIELDS_ABI, [
    {
      inputVmType: derivationFields.inputVmType,
      outputVmType: derivationFields.outputVmType,
      outputChainId: derivationFields.outputChainId,
      outputCurrency: derivationFields.outputCurrency as Hex,
      outputRecipient: derivationFields.outputRecipient as Hex,
      solver: derivationFields.solver as Address,
      pricingOracle: derivationFields.pricingOracle as Address,
      depositor: derivationFields.depositor as Hex,
      refundRecipient: derivationFields.refundRecipient as Hex,
      priceImpactBps: BigInt(derivationFields.priceImpactBps),
    },
  ]);
  return bytes32ToIndexes(keccak256(encoded));
}
