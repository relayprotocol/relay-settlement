import {
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
} from "https://cdn.jsdelivr.net/npm/viem@2.48.11/+esm";
import { decodeTronAddress } from "../../../common/address/tron.js";
import { bytesToHex, hexToBytes } from "../../../common/bytes.js";
import {
  decodeTronRawData,
  type ParsedTronTransaction,
  type ParsedTronTriggerSmartContract,
} from "../../../common/tron/transaction.js";
import type {
  DepositAddressTrigger,
  DepositAddressTriggerAttestation,
  TronVmTransaction,
} from "../../../common/types.js";

const TRON_NATIVE_CURRENCY = "410000000000000000000000000000000000000000";
const MAX_EXPIRATION_WINDOW_MS = 3_600_000n;
const MAX_FUTURE_TIMESTAMP_MS = 60_000n;
const MAX_FEE_LIMIT = 1_000_000_000n;
const DEPOSITORY_ABI = parseAbi([
  "function depositNative(address depositor, bytes32 id)",
  "function depositErc20(address depositor, address token, uint256 amount, bytes32 id)",
]);
const ERC20_ABI = parseAbi(["function approve(address spender, uint256 amount)"]);

/** Validate and normalize settlement-encoded Tron address bytes. */
function addressHex(value: string, field: string): string {
  const bytes = hexToBytes(value, field);
  try {
    decodeTronAddress(bytes);
  } catch (error) {
    throw new Error(`${field} must be a settlement-encoded Tron address: ${String(error)}`, {
      cause: error,
    });
  }
  return bytesToHex(bytes);
}

/** Convert validated 21-byte Tron protocol hex to a 20-byte TVM ABI address. */
function protocolHexToAbiAddress(value: string): Address {
  return `0x${value.slice(2)}`;
}

/** Convert settlement-encoded Tron address bytes to a TVM ABI address. */
function abiAddress(value: string, field: string): Address {
  return protocolHexToAbiAddress(addressHex(value, field));
}

/** Normalize a required bytes32 value for viem ABI encoding. */
function bytes32Hex(value: string, field: string): Hex {
  const bytes = hexToBytes(value, field);
  if (bytes.length !== 32) {
    throw new Error(`${field} must be 32 bytes`);
  }
  return `0x${bytesToHex(bytes)}`;
}

/** Parse a transaction and enforce freshness constraints. */
function parseAuthorizedTransaction(
  transaction: TronVmTransaction,
  index: number,
): ParsedTronTransaction {
  const parsed = decodeTronRawData(transaction.rawData);
  const now = BigInt(Date.now());
  if (parsed.rawData.expiration <= now) {
    throw new Error(`transactions[${index}]: transaction is expired`);
  }
  if (parsed.rawData.timestamp > now + MAX_FUTURE_TIMESTAMP_MS) {
    throw new Error(`transactions[${index}]: timestamp is too far in the future`);
  }
  if (parsed.rawData.expiration <= parsed.rawData.timestamp) {
    throw new Error(`transactions[${index}]: expiration must be after timestamp`);
  }
  if (parsed.rawData.expiration - parsed.rawData.timestamp > MAX_EXPIRATION_WINDOW_MS) {
    throw new Error(`transactions[${index}]: expiration exceeds the 1 hour maximum`);
  }
  if (parsed.rawData.feeLimit < 0n || parsed.rawData.feeLimit > MAX_FEE_LIMIT) {
    throw new Error(`transactions[${index}]: fee_limit exceeds the policy maximum`);
  }
  return parsed;
}

/** Require a TriggerSmartContract and return its decoded payload. */
function triggerContract(
  parsed: ParsedTronTransaction,
  index: number,
): ParsedTronTriggerSmartContract {
  if (parsed.rawData.contract.type !== "TriggerSmartContract") {
    throw new Error(`transactions[${index}]: expected TriggerSmartContract`);
  }
  return parsed.rawData.contract;
}

/** Validate one exact native-deposit transaction. */
function assertNativeDeposit(
  trigger: DepositAddressTrigger,
  attestation: DepositAddressTriggerAttestation,
  transactions: readonly TronVmTransaction[],
): void {
  if (transactions.length !== 1 || transactions[0].purpose !== "native-deposit") {
    throw new Error("native Tron deposit requires exactly one native-deposit transaction");
  }
  const contract = triggerContract(parseAuthorizedTransaction(transactions[0], 0), 0);
  const expectedDepository = addressHex(attestation.inputDepository, "attestation.inputDepository");
  if (contract.contractAddress !== expectedDepository) {
    throw new Error(
      `transactions[0]: contract_address must equal input depository ${expectedDepository}`,
    );
  }
  const amount = BigInt(trigger.input.amount);
  if (contract.callValue !== amount) {
    throw new Error(
      `transactions[0]: call_value must equal input.amount: expected=${amount}, got=${contract.callValue}`,
    );
  }
  const expectedData = encodeFunctionData({
    abi: DEPOSITORY_ABI,
    functionName: "depositNative",
    args: [
      abiAddress(trigger.derivationFields.depositor, "trigger.derivationFields.depositor"),
      bytes32Hex(trigger.orderId, "trigger.orderId"),
    ],
  }).slice(2);
  if (contract.data !== expectedData) {
    throw new Error("transactions[0]: depositNative calldata mismatch");
  }
}

/** Validate one approve stage against its exact expected amount. */
function assertApproval(
  transaction: TronVmTransaction,
  index: number,
  token: string,
  depository: string,
  amount: bigint,
): void {
  const contract = triggerContract(parseAuthorizedTransaction(transaction, index), index);
  if (contract.contractAddress !== token) {
    throw new Error(`transactions[${index}]: approval token mismatch`);
  }
  if (contract.callValue !== 0n) {
    throw new Error(`transactions[${index}]: approval call_value must be zero`);
  }
  const expectedData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [protocolHexToAbiAddress(depository), amount],
  }).slice(2);
  if (contract.data !== expectedData) {
    throw new Error(`transactions[${index}]: approve calldata mismatch`);
  }
}

/** Validate the ordered TRC20 approval and deposit batch. */
function assertTrc20Deposit(
  trigger: DepositAddressTrigger,
  attestation: DepositAddressTriggerAttestation,
  transactions: readonly TronVmTransaction[],
): void {
  const purposes = transactions.map((transaction) => transaction.purpose).join(",");
  const direct = "trc20-approval,trc20-deposit";
  const reset = "trc20-pre-approval,trc20-approval,trc20-deposit";
  if (purposes !== direct && purposes !== reset) {
    throw new Error(`invalid TRC20 transaction purposes: ${purposes}`);
  }
  const token = addressHex(trigger.input.currency, "trigger.input.currency");
  const depository = addressHex(attestation.inputDepository, "attestation.inputDepository");
  const amount = BigInt(trigger.input.amount);
  let depositIndex = 1;
  if (purposes === reset) {
    assertApproval(transactions[0], 0, token, depository, 0n);
    assertApproval(transactions[1], 1, token, depository, amount);
    depositIndex = 2;
  } else {
    assertApproval(transactions[0], 0, token, depository, amount);
  }
  const contract = triggerContract(
    parseAuthorizedTransaction(transactions[depositIndex], depositIndex),
    depositIndex,
  );
  if (contract.contractAddress !== depository) {
    throw new Error(`transactions[${depositIndex}]: contract_address must equal input depository`);
  }
  if (contract.callValue !== 0n) {
    throw new Error(`transactions[${depositIndex}]: depositErc20 call_value must be zero`);
  }
  const expectedData = encodeFunctionData({
    abi: DEPOSITORY_ABI,
    functionName: "depositErc20",
    args: [
      abiAddress(trigger.derivationFields.depositor, "trigger.derivationFields.depositor"),
      protocolHexToAbiAddress(token),
      amount,
      bytes32Hex(trigger.orderId, "trigger.orderId"),
    ],
  }).slice(2);
  if (contract.data !== expectedData) {
    throw new Error(`transactions[${depositIndex}]: depositErc20 calldata mismatch`);
  }
}

/** Enforce the exact native or TRC20 transaction shapes authorized for Tron. */
export function assertTronTransactions(
  trigger: DepositAddressTrigger,
  attestation: DepositAddressTriggerAttestation,
  transactions: readonly TronVmTransaction[],
): void {
  if (addressHex(trigger.input.currency, "trigger.input.currency") === TRON_NATIVE_CURRENCY) {
    assertNativeDeposit(trigger, attestation, transactions);
    return;
  }
  assertTrc20Deposit(trigger, attestation, transactions);
}
