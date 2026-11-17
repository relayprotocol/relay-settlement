import {
  decode,
  encode,
} from "https://cdn.jsdelivr.net/npm/ripple-binary-codec@2.8.0/dist/index.js/+esm";
import {
  decodeAbiParameters,
  encodeAbiParameters,
} from "https://cdn.jsdelivr.net/npm/viem@2.48.11/+esm";
import { decodeXrpAddress } from "../../../common/address/xrp.js";
import { bytesToHex, hexToBytes } from "../../../common/bytes.js";
import type {
  DepositAddressTrigger,
  DepositAddressTriggerAttestation,
  WalletInfo,
  XrpVmTransaction,
} from "../../../common/types.js";

// Match the Oracle's cap for unsigned XRP transaction parameters.
const MAX_FEE_DROPS = 10_000n;
const LEDGER_REFERENCE_ABI = [{ type: "uint32" }, { type: "uint64" }] as const;
const MAX_LEDGER_WINDOW = 32n;
const LEDGER_TIME_BUDGET_SECONDS = 10n;
// XRPL Mainnet forbids NetworkID in transactions; its protocol chain id is xrp.
const ALLOWED_FIELDS = new Set([
  "TransactionType",
  "Account",
  "Destination",
  "Amount",
  "Fee",
  "Sequence",
  "LastLedgerSequence",
  "Flags",
  "SigningPubKey",
  "Memos",
]);

/** Decode the supported unsigned Payment shape without discarding binary fields. */
export function parseXrpPayment(transaction: XrpVmTransaction): ReturnType<typeof decode> {
  const encoded = transaction.unsignedTransaction;
  if (typeof encoded !== "string" || !/^(?:[0-9a-fA-F]{2})+$/.test(encoded)) {
    throw new Error("XRP unsignedTransaction must be hex without a 0x prefix");
  }
  const payment = decode(encoded);
  if (encode(payment) !== encoded.toUpperCase()) {
    throw new Error("XRP Payment bytes must be canonical");
  }
  for (const field of Object.keys(payment)) {
    if (!ALLOWED_FIELDS.has(field)) {
      throw new Error(`unsupported XRP Payment field: ${field}`);
    }
  }
  if (payment.TransactionType !== "Payment") {
    throw new Error("XRP transaction must be a Payment");
  }
  for (const field of ["Amount", "Fee"] as const) {
    const value = payment[field];
    if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
      throw new Error(`XRP ${field} must be positive native drops`);
    }
  }
  if (BigInt(payment.Fee as string) > MAX_FEE_DROPS) {
    throw new Error(`XRP Fee exceeds ${MAX_FEE_DROPS} drops`);
  }
  for (const field of ["Sequence", "LastLedgerSequence"] as const) {
    const value = payment[field];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 0xffffffff) {
      throw new Error(`XRP ${field} must be a positive uint32`);
    }
  }
  if (payment.Flags !== undefined && payment.Flags !== 0 && payment.Flags !== 0x80000000) {
    throw new Error("XRP Flags may only set tfFullyCanonicalSig");
  }
  if (payment.SigningPubKey !== undefined && payment.SigningPubKey !== "") {
    throw new Error("XRP Payment must be unsigned");
  }
  return payment;
}

/** Bound expiry to the Oracle-attested ledger and time before prices expire. */
function assertLedgerWindow(
  trigger: DepositAddressTrigger,
  payment: ReturnType<typeof decode>,
): void {
  const [ledgerIndex, observedAt] = decodeAbiParameters(
    LEDGER_REFERENCE_ABI,
    trigger.extraData as `0x${string}`,
  );
  if (
    ledgerIndex < 1 ||
    encodeAbiParameters(LEDGER_REFERENCE_ABI, [ledgerIndex, observedAt]) !== trigger.extraData
  ) {
    throw new Error("XRP ledger reference must use canonical ABI encoding");
  }
  // Use the time checked by the Oracle so every node calculates the same window.
  let window = MAX_LEDGER_WINDOW;
  for (const price of trigger.prices) {
    const remainingLedgers = (BigInt(price.expiration) - observedAt) / LEDGER_TIME_BUDGET_SECONDS;
    if (remainingLedgers < window) {
      window = remainingLedgers;
    }
  }
  const lastLedgerSequence = BigInt(payment.LastLedgerSequence as number);
  if (
    lastLedgerSequence <= BigInt(ledgerIndex) ||
    lastLedgerSequence > BigInt(ledgerIndex) + window
  ) {
    throw new Error("XRP ledger expiry must be within the attested ledger window");
  }
}

/** Authorize one native sweep to the attested depository for the full input amount. */
export function assertXrpTransactions(
  trigger: DepositAddressTrigger,
  attestation: DepositAddressTriggerAttestation,
  transactions: readonly XrpVmTransaction[],
  wallet?: WalletInfo,
): void {
  if (trigger.input.chainId !== "xrp") {
    throw new Error("XRP input chain must be xrp");
  }
  if (transactions.length !== 1) {
    throw new Error("XRP sweep requires exactly one Payment");
  }
  if (!wallet || wallet.vmType !== "xrp-vm") {
    throw new Error("XRP sweep requires the derived XRP wallet");
  }
  if (trigger.input.currency.toLowerCase() !== `0x${"00".repeat(20)}`) {
    throw new Error("XRP sweep supports only native XRP");
  }
  const payment = parseXrpPayment(transactions[0]);
  if (payment.Account !== wallet.address) {
    throw new Error("XRP transaction Account mismatch");
  }
  if (
    payment.Destination !==
    decodeXrpAddress(hexToBytes(attestation.inputDepository, "attestation.inputDepository"))
  ) {
    throw new Error("XRP Destination must equal the attested input depository");
  }
  // The signed order fixes principal; fund the sweep fee and ledger reserve separately.
  if (payment.Amount !== trigger.input.amount) {
    throw new Error("XRP Amount must equal trigger input.amount");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(trigger.orderId)) {
    throw new Error("XRP orderId must be 32-byte hex");
  }
  const depositor = decodeXrpAddress(
    hexToBytes(trigger.derivationFields.depositor, "trigger.derivationFields.depositor"),
  );
  const memoData = bytesToHex(
    new TextEncoder().encode(`${trigger.orderId}|depositor=${depositor}|`),
  ).toUpperCase();
  if (JSON.stringify(payment.Memos) !== JSON.stringify([{ Memo: { MemoData: memoData } }])) {
    throw new Error("XRP Payment memo must bind orderId and depositor");
  }
  assertLedgerWindow(trigger, payment);
}
