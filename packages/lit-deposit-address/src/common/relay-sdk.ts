/**
 * Faithful port of the `@relay-protocol/settlement-sdk` methods the Lit
 * Action needs at verification time. We can't import the SDK directly into
 * the bundled action because it transitively requires `node:crypto` and
 * other heavy/Node-only modules; jsDelivr also can't generate an `+esm`
 * bundle for it. This file mirrors the relevant subset of:
 *
 *   - `dist/order/index.ts`         (ORDER_EIP712_TYPES, getOrderId)
 *   - `dist/hub/hub-utils.ts`       (generateAddress)
 *   - `dist/messages/v2.3/deposit-address.ts` (getDepositAddressTriggerHash)
 *
 * Per-VM order normalisation (the SDK's `normalizeOrder` / `encodeAddress`)
 * is intentionally omitted: callers are expected to pass order and address
 * fields already in their canonical bytes-hex form (i.e. what the SDK would
 * have produced after `encodeAddressToHex`). This keeps the bundle tiny and
 * avoids round-tripping already-canonical fields during order verification.
 */

import {
  encodeAbiParameters,
  encodePacked,
  getAddress,
  hashStruct,
  keccak256,
  type Address,
  type Hex,
} from "https://cdn.jsdelivr.net/npm/viem@2.48.11/+esm";

import type { DepositAddressTrigger } from "./types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Order shape signed by the solver and bound into the trigger hash. All
 * address-like fields (`solver`, `currency`, `recipient`, `extraData`, etc.)
 * are assumed to already be `0x`-prefixed bytes-hex strings, matching what
 * `@relay-protocol/settlement-sdk#normalizeOrder` would produce.
 */
export interface Order {
  version: "v1";
  solverChainId: string;
  solver: string;
  salt: string;
  inputs: Array<{
    payment: {
      chainId: string;
      currency: string;
      amount: string;
      weight: string;
    };
    refunds: Array<{
      chainId: string;
      recipient: string;
      currency: string;
      minimumAmount: string;
      deadline: number;
      extraData: string;
    }>;
  }>;
  output: {
    chainId: string;
    payments: Array<{
      recipient: string;
      currency: string;
      minimumAmount: string;
      expectedAmount: string;
    }>;
    calls: string[];
    deadline: number;
    extraData: string;
  };
  fees: Array<{
    recipientChainId: string;
    recipient: string;
    currencyChainId: string;
    currency: string;
    amount: string;
  }>;
}

export interface VirtualAddressComponents {
  chainId: string;
  /** Address must already be in its canonical bytes-hex form. */
  address: string;
}

// ─── EIP-712 type schemas ────────────────────────────────────────────────────

/** Mirrors `ORDER_EIP712_TYPES` in the SDK. */
const ORDER_EIP712_TYPES = {
  Order: [
    { name: "version", type: "string" },
    { name: "solverChainId", type: "string" },
    { name: "solver", type: "address" },
    { name: "salt", type: "uint256" },
    { name: "inputs", type: "Input[]" },
    { name: "output", type: "Output" },
    { name: "fees", type: "Fee[]" },
  ],
  Input: [
    { name: "payment", type: "InputPayment" },
    { name: "refunds", type: "InputRefund[]" },
  ],
  InputPayment: [
    { name: "chainId", type: "string" },
    { name: "currency", type: "bytes" },
    { name: "amount", type: "uint256" },
    { name: "weight", type: "uint256" },
  ],
  InputRefund: [
    { name: "chainId", type: "string" },
    { name: "recipient", type: "bytes" },
    { name: "currency", type: "bytes" },
    { name: "minimumAmount", type: "uint256" },
    { name: "deadline", type: "uint32" },
    { name: "extraData", type: "bytes" },
  ],
  Output: [
    { name: "chainId", type: "string" },
    { name: "payments", type: "OutputPayment[]" },
    { name: "deadline", type: "uint32" },
    { name: "calls", type: "bytes[]" },
    { name: "extraData", type: "bytes" },
  ],
  OutputPayment: [
    { name: "recipient", type: "bytes" },
    { name: "currency", type: "bytes" },
    { name: "minimumAmount", type: "uint256" },
    { name: "expectedAmount", type: "uint256" },
  ],
  Fee: [
    { name: "recipientChainId", type: "string" },
    { name: "recipient", type: "bytes" },
    { name: "currencyChainId", type: "string" },
    { name: "currency", type: "bytes" },
    { name: "amount", type: "uint256" },
  ],
} as const;

/** Mirrors the deposit-address trigger encoding used by `getDepositAddressTriggerHash`. */
const TRIGGER_HASH_ABI = [
  {
    type: "tuple",
    components: [
      { name: "vmType", type: "string" },
      { name: "chainId", type: "string" },
      { name: "currency", type: "bytes" },
      { name: "amount", type: "uint256" },
    ],
  },
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
  { type: "bytes32" },
  { type: "uint256" },
  {
    type: "tuple[]",
    components: [
      { name: "chainId", type: "string" },
      { name: "currency", type: "bytes" },
    ],
  },
  {
    type: "tuple[]",
    components: [
      { name: "usdPrice", type: "uint256" },
      { name: "usdPriceDecimals", type: "uint8" },
      { name: "currencyDecimals", type: "uint8" },
      { name: "expiration", type: "uint256" },
    ],
  },
  { type: "bytes" },
] as const;

// ─── Virtual address ────────────────────────────────────────────────────────

/**
 * Compute the Relay-protocol virtual address for `(chainId, address)`,
 * mirroring `generateAddress` in `@relay-protocol/settlement-sdk`. The
 * `address` argument is assumed to already be in its canonical bytes-hex
 * form (the SDK's `family` parameter is unused here — we encode by family
 * before calling, when needed).
 */
export function generateAddress({ chainId, address }: VirtualAddressComponents): Address {
  const hash = keccak256(encodePacked(["string", "bytes"], [chainId, address as Hex]));
  return getAddress(`0x${hash.slice(-40)}`);
}

// ─── Order id ───────────────────────────────────────────────────────────────

/**
 * EIP-712 `hashStruct` of an order. Equivalent to `getOrderId` in the SDK,
 * with the caveat that all address-like fields are assumed to already be in
 * canonical bytes-hex form (i.e. the result of `normalizeOrder`).
 */
export function getOrderId(order: Order): Hex {
  // viem coerces string/number values to bigint/hex at hash time. Our
  // string-typed `Order` is intentionally looser than viem's structurally
  // -inferred type, so cast the whole parameter set.
  const args = {
    types: ORDER_EIP712_TYPES,
    primaryType: "Order",
    data: order,
  } as unknown as Parameters<typeof hashStruct>[0];
  return hashStruct(args);
}

// ─── Deposit-address trigger hash ───────────────────────────────────────────

/**
 * `keccak256(abi.encode(trigger))` per the canonical encoding produced by
 * `@relay-protocol/settlement-sdk#getDepositAddressTriggerHash`.
 */
export function getDepositAddressTriggerHash(trigger: DepositAddressTrigger): Hex {
  return keccak256(
    encodeAbiParameters(TRIGGER_HASH_ABI, [
      {
        vmType: trigger.input.vmType,
        chainId: trigger.input.chainId,
        currency: trigger.input.currency as Hex,
        amount: BigInt(trigger.input.amount),
      },
      {
        inputVmType: trigger.derivationFields.inputVmType,
        outputVmType: trigger.derivationFields.outputVmType,
        outputChainId: trigger.derivationFields.outputChainId,
        outputCurrency: trigger.derivationFields.outputCurrency as Hex,
        outputRecipient: trigger.derivationFields.outputRecipient as Hex,
        solver: trigger.derivationFields.solver as Address,
        pricingOracle: trigger.derivationFields.pricingOracle as Address,
        depositor: trigger.derivationFields.depositor as Hex,
        refundRecipient: trigger.derivationFields.refundRecipient as Hex,
        priceImpactBps: BigInt(trigger.derivationFields.priceImpactBps),
      },
      trigger.orderId as Hex,
      BigInt(trigger.nonce),
      trigger.currencies.map((c) => ({ chainId: c.chainId, currency: c.currency as Hex })),
      trigger.prices.map((p) => ({
        usdPrice: BigInt(p.usdPrice),
        usdPriceDecimals: p.usdPriceDecimals,
        currencyDecimals: p.currencyDecimals,
        expiration: BigInt(p.expiration),
      })),
      trigger.extraData as Hex,
    ]),
  );
}
