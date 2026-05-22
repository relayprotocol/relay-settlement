import { secp256k1 } from "https://cdn.jsdelivr.net/npm/@noble/curves@2.0.1/secp256k1.js/+esm#sha384-EtK9grXXeMKBkEYOQQfnqbuL27d6fm62SvYWp0bXat9Nh0VIK6vdGAqidcU/3m+d";
import { hexToBytes } from "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/utils.js/+esm#sha384-81Ys7folK9g1yP638SSxYBut5/EduVcZkl91gBJkPC/7ox5wD+2MJVne2gymPq4f";
import {
  getAddress,
  hashMessage,
  hashTypedData,
  keccak256,
  zeroAddress,
  type Address,
  type Hex,
  type TypedDataDefinition,
} from "https://cdn.jsdelivr.net/npm/viem@2.48.11/+esm#sha384-YppD9Zm3WvzBC3kmMreLoS2VRCnN1bgrD8Ai2tGMcfMQsNoKMdWqL+ToE+kej/ys";
import {
  ALLOWED_ORACLES,
  DEPOSIT_ADDRESS_MANAGER_ADDRESS,
  HUB_EVM_CHAIN_ID,
  ORACLE_SIGNATURE_THRESHOLD,
} from "../config.js";
import {
  generateAddress,
  getDepositAddressTriggerHash,
  getOrderId,
  type Order,
} from "../common/relay-sdk.js";
import type { DepositAddressTrigger, DepositAddressTriggerAttestation } from "../common/types.js";

/** EIP-712 typed-data schema oracles use when signing trigger attestations. */
const TRIGGER_TYPED_DATA = {
  primaryType: "Trigger" as const,
  types: {
    Trigger: [
      { name: "chainId", type: "uint256" },
      { name: "depositAddressManager", type: "address" },
      { name: "inputDepository", type: "bytes" },
      { name: "triggerHash", type: "bytes32" },
    ],
  },
} as const;

/** Checksum and validate a hex address, throwing with a descriptive error. */
function normalizeAddress(address: string): Address {
  try {
    return getAddress(address);
  } catch {
    throw new Error(`${address} is not a valid address`);
  }
}

/** Convert a big-endian byte array to a `bigint`. */
function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

/**
 * Recover an Ethereum address from a 32-byte digest + 65-byte ECDSA signature.
 *
 * viem's high-level recover helpers (`recoverTypedDataAddress`,
 * `recoverMessageAddress`) internally do `await import("@noble/curves/...")`
 * which the Lit Action runtime forbids. We hash the message ourselves with
 * viem's sync helpers and run ECDSA recovery directly against the
 * statically-imported `@noble/curves` secp256k1 primitive.
 */
function recoverAddressFromDigest(digest: Hex, signature: Hex): Address {
  const sigBytes = hexToBytes(signature.startsWith("0x") ? signature.slice(2) : signature);
  if (sigBytes.length !== 65) {
    throw new Error(`signature must be 65 bytes, got ${sigBytes.length}`);
  }

  const r = bytesToBigInt(sigBytes.slice(0, 32));
  const s = bytesToBigInt(sigBytes.slice(32, 64));
  let v = sigBytes[64];
  if (v >= 27) {
    v -= 27;
  }
  if (v !== 0 && v !== 1) {
    throw new Error(`invalid recovery bit: ${sigBytes[64]}`);
  }

  const sig = new secp256k1.Signature(r, s).addRecoveryBit(v);
  const digestBytes = hexToBytes(digest.slice(2));
  const pubKey = sig.recoverPublicKey(digestBytes);
  const uncompressed = pubKey.toBytes(false);
  const addrHash = keccak256(uncompressed.slice(1));
  return getAddress(`0x${addrHash.slice(-40)}`);
}

/** Recover the signer of an EIP-712 typed-data signature. */
function recoverEip712Address(typedData: TypedDataDefinition, signature: Hex): Address {
  return recoverAddressFromDigest(hashTypedData(typedData), signature);
}

/**
 * Recover the signer of an EIP-191 `personal_sign` signature over a raw
 * (hex-encoded) message.
 */
function recoverPersonalSignAddress(message: Hex, signature: Hex): Address {
  return recoverAddressFromDigest(hashMessage({ raw: message }), signature);
}

/** Recover the signer address from a trigger-attestation EIP-712 signature. */
function recoverTriggerSigner(
  attestation: DepositAddressTriggerAttestation,
  signature: Hex,
): Address | undefined {
  try {
    return recoverEip712Address(
      {
        ...TRIGGER_TYPED_DATA,
        domain: {
          chainId: BigInt(attestation.chainId),
          name: "Trigger",
          verifyingContract: zeroAddress,
          version: "1",
        },
        message: {
          chainId: BigInt(attestation.chainId),
          depositAddressManager: normalizeAddress(attestation.depositAddressManager),
          inputDepository: attestation.inputDepository as Hex,
          triggerHash: attestation.triggerHash as Hex,
        },
      },
      signature,
    );
  } catch {
    return undefined;
  }
}

/**
 * Verify an oracle attestation over a deposit-address trigger.
 *
 * Checks that:
 * - the recomputed trigger hash matches `attestation.triggerHash`
 * - `attestation.chainId` matches the bundled hub chain id
 * - `attestation.depositAddressManager` matches the bundled manager address
 * - every signature is by an allowlisted oracle and recovers to its claimed
 *   `oracleSigner` over the EIP-712 typed-data digest
 * - at least `ORACLE_SIGNATURE_THRESHOLD` distinct allowlisted oracles signed
 *
 * Throws on the first failed invariant.
 */
export async function verifyDepositAddressTriggerAttestation(
  trigger: DepositAddressTrigger,
  attestation: DepositAddressTriggerAttestation,
): Promise<void> {
  const expectedTriggerHash = getDepositAddressTriggerHash(trigger);
  if (attestation.triggerHash.toLowerCase() !== expectedTriggerHash.toLowerCase()) {
    throw new Error(
      `attestation triggerHash mismatch: expected=${expectedTriggerHash}, provided=${attestation.triggerHash}`,
    );
  }

  if (attestation.chainId !== HUB_EVM_CHAIN_ID) {
    throw new Error(
      `attestation chainId mismatch: expected=${HUB_EVM_CHAIN_ID}, provided=${attestation.chainId}`,
    );
  }

  const expectedManager = normalizeAddress(DEPOSIT_ADDRESS_MANAGER_ADDRESS);
  const providedManager = normalizeAddress(attestation.depositAddressManager);
  if (expectedManager !== providedManager) {
    throw new Error(
      `attestation depositAddressManager mismatch: expected=${expectedManager}, provided=${providedManager}`,
    );
  }

  const allowed = new Set(ALLOWED_ORACLES.map(normalizeAddress));
  const verified = new Set<Address>();

  for (const sig of attestation.signatures) {
    const oracle = normalizeAddress(sig.oracleSigner);
    if (!allowed.has(oracle)) {
      throw new Error(`attestation oracle is not allowlisted: ${sig.oracleSigner}`);
    }

    const recovered = recoverTriggerSigner(attestation, sig.signature as Hex);
    if (!recovered || normalizeAddress(recovered) !== oracle) {
      throw new Error(`attestation signature mismatch for oracle ${sig.oracleSigner}`);
    }

    verified.add(oracle);
  }

  if (verified.size < ORACLE_SIGNATURE_THRESHOLD) {
    throw new Error(
      `attestation signature threshold not met: required=${ORACLE_SIGNATURE_THRESHOLD}, verified=${verified.size}`,
    );
  }
}

/**
 * Verify the solver order tied to a trigger.
 *
 * Checks that:
 * - The order has exactly one input with `weight == "1"` whose `(chainId,
 *   currency, amount)` matches `trigger.input`.
 * - That input has at least one refund; the first refund's `(chainId,
 *   currency)` must match `trigger.input.(chainId, currency)` and its
 *   `recipient` must match `derivationFields.refundRecipient`.
 * - The order has exactly one output payment, no `output.calls`, and the
 *   payment's `(chainId, currency, recipient)` matches the corresponding
 *   `derivationFields` fields.
 * - `getOrderId(order)` recomputes to `trigger.orderId`, so the caller can't
 *   substitute an unrelated order with the same id. The order's address-like
 *   fields must already be in their canonical bytes-hex form.
 * - `orderSignature` is an EIP-191 `personal_sign` over `trigger.orderId` by
 *   `order.solver` (the address the solver advertises in the order).
 * - `derivationFields.solver` is the relay-protocol `ethereum-vm` virtual
 *   address derived from `(order.solverChainId, order.solver)`. This binds
 *   the order's solver to the wallet derivation path so a malicious caller
 *   can't substitute a different order with the same derivation fields.
 */
export function verifyOrderData(
  trigger: DepositAddressTrigger,
  order: Order,
  orderSignature: string,
): void {
  // ── Input ───────────────────────────────────────────────────────────────
  if (order.inputs.length !== 1) {
    throw new Error(`expected order to have exactly one input, got ${order.inputs.length}`);
  }
  const orderInput = order.inputs[0].payment;
  if (orderInput.weight !== "1") {
    throw new Error(`order input weight must be "1", got "${orderInput.weight}"`);
  }
  if (orderInput.chainId !== trigger.input.chainId) {
    throw new Error(
      `order input chainId mismatch: order=${orderInput.chainId}, trigger=${trigger.input.chainId}`,
    );
  }
  if (orderInput.currency.toLowerCase() !== trigger.input.currency.toLowerCase()) {
    throw new Error(
      `order input currency mismatch: order=${orderInput.currency}, trigger=${trigger.input.currency}`,
    );
  }
  if (orderInput.amount !== trigger.input.amount) {
    throw new Error(
      `order input amount mismatch: order=${orderInput.amount}, trigger=${trigger.input.amount}`,
    );
  }

  // ── Refunds ─────────────────────────────────────────────────────────────
  // Validate EVERY refund entry, not just refunds[0]. The depository can
  // honour any refund the solver listed in the signed order, so an entry
  // routed elsewhere would let a caller siphon funds while still passing
  // signer checks.
  if (order.inputs[0].refunds.length < 1) {
    throw new Error("expected order input to have at least one refund, got 0");
  }
  for (let i = 0; i < order.inputs[0].refunds.length; i++) {
    const orderRefund = order.inputs[0].refunds[i];
    if (orderRefund.chainId !== trigger.input.chainId) {
      throw new Error(
        `order refund[${i}] chainId mismatch: order=${orderRefund.chainId}, trigger=${trigger.input.chainId}`,
      );
    }
    if (orderRefund.currency.toLowerCase() !== trigger.input.currency.toLowerCase()) {
      throw new Error(
        `order refund[${i}] currency mismatch: order=${orderRefund.currency}, trigger=${trigger.input.currency}`,
      );
    }
    if (
      orderRefund.recipient.toLowerCase() !== trigger.derivationFields.refundRecipient.toLowerCase()
    ) {
      throw new Error(
        `order refund[${i}] recipient mismatch: order=${orderRefund.recipient}, derivationFields=${trigger.derivationFields.refundRecipient}`,
      );
    }
  }

  // ── Output ──────────────────────────────────────────────────────────────
  if (order.output.payments.length !== 1) {
    throw new Error(
      `expected order output to have exactly one payment, got ${order.output.payments.length}`,
    );
  }
  if (order.output.calls.length !== 0) {
    throw new Error(`expected order output to have no calls, got ${order.output.calls.length}`);
  }
  const orderOutput = order.output.payments[0];
  if (order.output.chainId !== trigger.derivationFields.outputChainId) {
    throw new Error(
      `order output chainId mismatch: order=${order.output.chainId}, derivationFields=${trigger.derivationFields.outputChainId}`,
    );
  }
  if (
    orderOutput.currency.toLowerCase() !== trigger.derivationFields.outputCurrency.toLowerCase()
  ) {
    throw new Error(
      `order output currency mismatch: order=${orderOutput.currency}, derivationFields=${trigger.derivationFields.outputCurrency}`,
    );
  }
  if (
    orderOutput.recipient.toLowerCase() !== trigger.derivationFields.outputRecipient.toLowerCase()
  ) {
    throw new Error(
      `order output recipient mismatch: order=${orderOutput.recipient}, derivationFields=${trigger.derivationFields.outputRecipient}`,
    );
  }

  // ── Price impact ────────────────────────────────────────────────────────────
  const findPrice = (chainId: string, currency: string) => {
    for (let i = 0; i < trigger.currencies.length; i++) {
      const entry = trigger.currencies[i];
      if (entry.chainId === chainId && entry.currency.toLowerCase() === currency.toLowerCase()) {
        return trigger.prices[i];
      }
    }
    return undefined;
  };

  const inputPrice = findPrice(trigger.input.chainId, trigger.input.currency);
  if (!inputPrice) {
    throw new Error(
      `no price found for input currency (chainId=${trigger.input.chainId}, currency=${trigger.input.currency})`,
    );
  }
  const outputPrice = findPrice(
    trigger.derivationFields.outputChainId,
    trigger.derivationFields.outputCurrency,
  );
  if (!outputPrice) {
    throw new Error(
      `no price found for output currency (chainId=${trigger.derivationFields.outputChainId}, currency=${trigger.derivationFields.outputCurrency})`,
    );
  }

  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  if (BigInt(inputPrice.expiration) <= nowSeconds) {
    throw new Error(`input price expired: expiration=${inputPrice.expiration}, now=${nowSeconds}`);
  }
  if (BigInt(outputPrice.expiration) <= nowSeconds) {
    throw new Error(
      `output price expired: expiration=${outputPrice.expiration}, now=${nowSeconds}`,
    );
  }

  // Compare USD values of input.amount and output.minimumAmount. Per the
  // IPricingOracle Price NatSpec:
  //   usd = rawAmount * usdPrice / (10 ** currencyDecimals)
  // expressed in `10 ** usdPriceDecimals` USD. To compare both sides without
  // losing precision we cross-multiply by the opposite side's scales (both
  // the usd-price precision and the currency's own decimals).
  const inputUsdScaled =
    BigInt(trigger.input.amount) *
    BigInt(inputPrice.usdPrice) *
    10n ** BigInt(outputPrice.usdPriceDecimals + outputPrice.currencyDecimals);
  const outputUsdScaled =
    BigInt(orderOutput.minimumAmount) *
    BigInt(outputPrice.usdPrice) *
    10n ** BigInt(inputPrice.usdPriceDecimals + inputPrice.currencyDecimals);
  const priceImpactBps = BigInt(trigger.derivationFields.priceImpactBps);
  if (priceImpactBps > 10_000n) {
    throw new Error(`priceImpactBps must be <= 10000, got=${priceImpactBps}`);
  }
  // outputUsd >= inputUsd * (10000 - priceImpactBps) / 10000
  if (outputUsdScaled * 10_000n < inputUsdScaled * (10_000n - priceImpactBps)) {
    throw new Error(
      `price impact exceeded: input.amount=${trigger.input.amount} (usdPrice=${inputPrice.usdPrice}, usdPriceDecimals=${inputPrice.usdPriceDecimals}, currencyDecimals=${inputPrice.currencyDecimals}), output.minimumAmount=${orderOutput.minimumAmount} (usdPrice=${outputPrice.usdPrice}, usdPriceDecimals=${outputPrice.usdPriceDecimals}, currencyDecimals=${outputPrice.currencyDecimals}), priceImpactBps=${trigger.derivationFields.priceImpactBps}`,
    );
  }

  const recomputedOrderId = getOrderId(order);
  if (recomputedOrderId.toLowerCase() !== trigger.orderId.toLowerCase()) {
    throw new Error(
      `order id mismatch: recomputed=${recomputedOrderId}, trigger.orderId=${trigger.orderId}`,
    );
  }

  const recovered = recoverPersonalSignAddress(trigger.orderId as Hex, orderSignature as Hex);
  if (recovered.toLowerCase() !== order.solver.toLowerCase()) {
    throw new Error(
      `order signature mismatch: recovered=${recovered}, order.solver=${order.solver}`,
    );
  }

  const expectedVirtual = generateAddress({
    chainId: order.solverChainId,
    address: order.solver,
  });
  if (expectedVirtual.toLowerCase() !== trigger.derivationFields.solver.toLowerCase()) {
    throw new Error(
      `derivation fields solver mismatch: derivationFields.solver=${trigger.derivationFields.solver}, expected=${expectedVirtual} (chainId=${order.solverChainId}, solver=${order.solver})`,
    );
  }
}
