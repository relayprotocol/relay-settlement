import { SLIP10Node } from "https://cdn.jsdelivr.net/npm/@metamask/key-tree@10.1.1/+esm";
import { secp256k1 } from "https://cdn.jsdelivr.net/npm/@noble/curves@2.0.1/secp256k1.js/+esm";
import {
  parseTransaction,
  serializeTransaction,
  type Hex,
} from "https://cdn.jsdelivr.net/npm/viem@2.48.11/+esm";
import { encodeAddressToHex, normalizeAddressHex } from "../../../common/address.js";
import { bytesToHex, hexToBytes } from "../../../common/bytes.js";
import { keccak256 } from "../../../common/crypto.js";
import type {
  DepositAddressTrigger,
  DepositAddressTriggerAttestation,
  EthereumVmSignedTransaction,
  EthereumVmTransaction,
  WalletInfo,
} from "../../../common/types.js";
import { Secp256k1VmWalletDeriver } from "../base/Secp256k1VmWalletDeriver.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// 4-byte function selectors are hardcoded to keep the bundle small and to
// avoid a runtime keccak256 over each signature string. They are
// keccak256(<signature>)[0..4]:
//   depositNative(address,bytes32)                 → 0x49290c1c
//   approve(address,uint256)                       → 0x095ea7b3
//   depositErc20(address,address,uint256,bytes32)  → 0xe8017952
const DEPOSIT_NATIVE_SELECTOR = "0x49290c1c" as const;
const ERC20_APPROVE_SELECTOR = "0x095ea7b3" as const;
const DEPOSIT_ERC20_SELECTOR = "0xe8017952" as const;

const DEPOSIT_NATIVE_SIGNATURE = "depositNative(address,bytes32)";
const ERC20_APPROVE_SIGNATURE = "approve(address,uint256)";
const DEPOSIT_ERC20_SIGNATURE = "depositErc20(address,address,uint256,bytes32)";

/** Length in hex characters of one ABI 32-byte word. */
const WORD_HEX_LEN = 64;

/** Slice the N-th 32-byte argument word out of ABI-encoded calldata. */
function wordAt(data: Hex, index: number): string {
  // 2 char `0x` prefix + 8 char selector + index * 64 char word.
  const start = 2 + 8 + index * WORD_HEX_LEN;
  return data.slice(start, start + WORD_HEX_LEN);
}

/** Decode an ABI-encoded `address` (right-aligned in a 32-byte word). */
function decodeAddressArg(data: Hex, index: number): string {
  const word = wordAt(data, index);
  return `0x${word.slice(24).toLowerCase()}`;
}

/** Decode an ABI-encoded `uint256`. */
function decodeUint256Arg(data: Hex, index: number): bigint {
  return BigInt(`0x${wordAt(data, index)}`);
}

/** Decode an ABI-encoded `bytes32` (already a full word). */
function decodeBytes32Arg(data: Hex, index: number): Hex {
  return `0x${wordAt(data, index).toLowerCase()}` as Hex;
}

function assertZeroValue(txIndex: number, value: bigint | undefined): void {
  const actual = value ?? 0n;
  if (actual !== 0n) {
    throw new Error(
      `transactions[${txIndex}]: value must be zero for ERC-20 deposits, got=${actual}`,
    );
  }
}

/**
 * EVM wallet deriver. Produces 20-byte EOA addresses derived from the
 * uncompressed secp256k1 public key and signs serialized unsigned EVM
 * transactions, returning the serialized signed transaction plus its
 * keccak256 hash.
 */
export class EthereumVmWalletDeriver extends Secp256k1VmWalletDeriver<
  EthereumVmTransaction,
  EthereumVmSignedTransaction
> {
  readonly vmType = "ethereum-vm" as const;
  protected readonly accountPath = "m/44'/60'/0'/0";
  protected readonly accountSegments = ["bip32:44'", "bip32:60'", "bip32:0'", "bip32:0"] as const;

  /**
   * Reject any unsigned transaction batch that doesn't match the expected
   * deposit shape for the current trigger.
   *
   * Two flows are accepted, dispatched on `trigger.input.currency`:
   *
   * 1. Native (`input.currency === 0x0`): exactly one transaction calling
   *    `depositNative(depositor, orderId)` on `attestation.inputDepository`.
   *
   * 2. ERC-20 (anything else): exactly two transactions:
   *      [0] `approve(spender=inputDepository, value=input.amount)`
   *          on the token contract (`input.currency`),
   *      [1] `depositErc20(depositor, token, amount, orderId)` on the
   *          depository, with `token === input.currency` and
   *          `amount === input.amount`.
   *
   * In both flows `depositor` must equal `derivationFields.depositor` and
   * `orderId` must equal `trigger.orderId`. Throws with a descriptive error
   * on the first violated constraint.
   */
  override verifyTransactions(
    trigger: DepositAddressTrigger,
    attestation: DepositAddressTriggerAttestation,
    transactions: readonly EthereumVmTransaction[],
  ): void {
    if (normalizeAddressHex(trigger.input.currency, "ethereum-vm") === ZERO_ADDRESS) {
      this.verifyNativeDeposit(trigger, attestation, transactions);
    } else {
      this.verifyErc20Deposit(trigger, attestation, transactions);
    }
  }

  /** Validate the native (single-tx) deposit flow. */
  private verifyNativeDeposit(
    trigger: DepositAddressTrigger,
    attestation: DepositAddressTriggerAttestation,
    transactions: readonly EthereumVmTransaction[],
  ): void {
    if (transactions.length !== 1) {
      throw new Error(
        `native deposit requires exactly 1 transaction (depositNative), got ${transactions.length}`,
      );
    }
    const parsed = parseTransaction(transactions[0].unsignedTransaction as Hex);
    const expectedTo = normalizeAddressHex(attestation.inputDepository, "ethereum-vm");
    const actualTo = parsed.to
      ? encodeAddressToHex(parsed.to, "ethereum-vm").toLowerCase()
      : undefined;
    if (!actualTo || actualTo !== expectedTo) {
      throw new Error(
        `transactions[0]: "to" must equal input depository ${expectedTo}, got ${parsed.to ?? "<missing>"}`,
      );
    }

    const expectedAmount = BigInt(trigger.input.amount);
    const actualValue = parsed.value ?? 0n;
    if (actualValue !== expectedAmount) {
      throw new Error(
        `transactions[0]: value must equal input.amount: expected=${expectedAmount}, got=${actualValue}`,
      );
    }
    const data = (parsed.data ?? "0x") as Hex;
    if (!data.toLowerCase().startsWith(DEPOSIT_NATIVE_SELECTOR)) {
      throw new Error(
        `transactions[0]: data must call ${DEPOSIT_NATIVE_SIGNATURE} (selector ${DEPOSIT_NATIVE_SELECTOR})`,
      );
    }
    const expectedLen = 2 + 8 + 2 * WORD_HEX_LEN;
    if (data.length !== expectedLen) {
      throw new Error(
        `transactions[0]: ${DEPOSIT_NATIVE_SIGNATURE} calldata length mismatch: expected ${expectedLen} chars, got ${data.length}`,
      );
    }

    const depositor = decodeAddressArg(data, 0);
    const depositorHex = encodeAddressToHex(depositor, "ethereum-vm").toLowerCase();
    const expectedDepositor = normalizeAddressHex(
      trigger.derivationFields.depositor,
      "ethereum-vm",
    );
    if (depositorHex !== expectedDepositor) {
      throw new Error(
        `transactions[0]: depositNative.depositor mismatch: expected=${expectedDepositor}, got=${depositor} (${depositorHex})`,
      );
    }

    const orderId = decodeBytes32Arg(data, 1);
    if (orderId.toLowerCase() !== trigger.orderId.toLowerCase()) {
      throw new Error(
        `transactions[0]: depositNative.orderId mismatch: expected=${trigger.orderId}, got=${orderId}`,
      );
    }
  }

  /** Validate the ERC-20 (two-tx: approve + depositErc20) deposit flow. */
  private verifyErc20Deposit(
    trigger: DepositAddressTrigger,
    attestation: DepositAddressTriggerAttestation,
    transactions: readonly EthereumVmTransaction[],
  ): void {
    if (transactions.length !== 2) {
      throw new Error(
        `erc-20 deposit requires exactly 2 transactions (approve + depositErc20), got ${transactions.length}`,
      );
    }
    const expectedAmount = BigInt(trigger.input.amount);

    // ── tx[0]: token.approve(spender = inputDepository, value = input.amount)
    const approveTx = parseTransaction(transactions[0].unsignedTransaction as Hex);
    assertZeroValue(0, approveTx.value);
    const expectedTokenTo = normalizeAddressHex(trigger.input.currency, "ethereum-vm");
    const actualTokenTo = approveTx.to
      ? encodeAddressToHex(approveTx.to, "ethereum-vm").toLowerCase()
      : undefined;
    if (!actualTokenTo || actualTokenTo !== expectedTokenTo) {
      throw new Error(
        `transactions[0]: "to" must equal input.currency (token) ${expectedTokenTo}, got ${approveTx.to ?? "<missing>"}`,
      );
    }

    const approveData = (approveTx.data ?? "0x") as Hex;
    if (!approveData.toLowerCase().startsWith(ERC20_APPROVE_SELECTOR)) {
      throw new Error(
        `transactions[0]: data must call ${ERC20_APPROVE_SIGNATURE} (selector ${ERC20_APPROVE_SELECTOR})`,
      );
    }
    const approveExpectedLen = 2 + 8 + 2 * WORD_HEX_LEN;
    if (approveData.length !== approveExpectedLen) {
      throw new Error(
        `transactions[0]: ${ERC20_APPROVE_SIGNATURE} calldata length mismatch: expected ${approveExpectedLen} chars, got ${approveData.length}`,
      );
    }
    const approveSpender = decodeAddressArg(approveData, 0);
    const approveValue = decodeUint256Arg(approveData, 1);
    const approveSpenderHex = encodeAddressToHex(approveSpender, "ethereum-vm").toLowerCase();
    const expectedSpender = normalizeAddressHex(attestation.inputDepository, "ethereum-vm");
    if (approveSpenderHex !== expectedSpender) {
      throw new Error(
        `transactions[0]: approve.spender mismatch: expected=${expectedSpender}, got=${approveSpender} (${approveSpenderHex})`,
      );
    }
    if (approveValue !== expectedAmount) {
      throw new Error(
        `transactions[0]: approve.value mismatch: expected=${expectedAmount}, got=${approveValue}`,
      );
    }

    // ── tx[1]: depository.depositErc20(depositor, token, amount, orderId)
    const depositTx = parseTransaction(transactions[1].unsignedTransaction as Hex);
    assertZeroValue(1, depositTx.value);
    const expectedDepositTo = normalizeAddressHex(attestation.inputDepository, "ethereum-vm");
    const actualDepositTo = depositTx.to
      ? encodeAddressToHex(depositTx.to, "ethereum-vm").toLowerCase()
      : undefined;
    if (!actualDepositTo || actualDepositTo !== expectedDepositTo) {
      throw new Error(
        `transactions[1]: "to" must equal input depository ${expectedDepositTo}, got ${depositTx.to ?? "<missing>"}`,
      );
    }

    const depositData = (depositTx.data ?? "0x") as Hex;
    if (!depositData.toLowerCase().startsWith(DEPOSIT_ERC20_SELECTOR)) {
      throw new Error(
        `transactions[1]: data must call ${DEPOSIT_ERC20_SIGNATURE} (selector ${DEPOSIT_ERC20_SELECTOR})`,
      );
    }
    const depositExpectedLen = 2 + 8 + 4 * WORD_HEX_LEN;
    if (depositData.length !== depositExpectedLen) {
      throw new Error(
        `transactions[1]: ${DEPOSIT_ERC20_SIGNATURE} calldata length mismatch: expected ${depositExpectedLen} chars, got ${depositData.length}`,
      );
    }
    const depositor = decodeAddressArg(depositData, 0);
    const token = decodeAddressArg(depositData, 1);
    const amount = decodeUint256Arg(depositData, 2);
    const orderId = decodeBytes32Arg(depositData, 3);

    const erc20DepositorHex = encodeAddressToHex(depositor, "ethereum-vm").toLowerCase();
    const expectedErc20Depositor = normalizeAddressHex(
      trigger.derivationFields.depositor,
      "ethereum-vm",
    );
    if (erc20DepositorHex !== expectedErc20Depositor) {
      throw new Error(
        `transactions[1]: depositErc20.depositor mismatch: expected=${expectedErc20Depositor}, got=${depositor} (${erc20DepositorHex})`,
      );
    }

    const tokenHex = encodeAddressToHex(token, "ethereum-vm").toLowerCase();
    const expectedToken = normalizeAddressHex(trigger.input.currency, "ethereum-vm");
    if (tokenHex !== expectedToken) {
      throw new Error(
        `transactions[1]: depositErc20.token mismatch: expected=${expectedToken}, got=${token} (${tokenHex})`,
      );
    }
    if (amount !== expectedAmount) {
      throw new Error(
        `transactions[1]: depositErc20.amount mismatch: expected=${expectedAmount}, got=${amount}`,
      );
    }
    if (orderId.toLowerCase() !== trigger.orderId.toLowerCase()) {
      throw new Error(
        `transactions[1]: depositErc20.orderId mismatch: expected=${trigger.orderId}, got=${orderId}`,
      );
    }
  }

  protected walletFromNode(indexes: readonly number[], childNode: SLIP10Node): WalletInfo {
    const uncompressed = secp256k1.Point.fromHex(
      bytesToHex(childNode.compressedPublicKeyBytes),
    ).toBytes(false);
    const address = `0x${bytesToHex(keccak256(uncompressed.slice(1)).slice(12))}`;
    return {
      vmType: this.vmType,
      indexes: [...indexes],
      path: this.path(indexes),
      address,
      publicKey: childNode.compressedPublicKey,
    };
  }

  protected async signTransactionWithKey(
    privateKey: Uint8Array,
    transaction: EthereumVmTransaction,
  ): Promise<EthereumVmSignedTransaction> {
    const unsignedHex = transaction.unsignedTransaction as Hex;
    const parsed = parseTransaction(unsignedHex);
    const digest = keccak256(hexToBytes(unsignedHex, "unsignedTransaction"));
    const sig = signEvmDigest(digest, privateKey);
    const rawTransaction = serializeTransaction(parsed, buildSignature(parsed, sig));
    return {
      rawTransaction,
      transactionHash: `0x${bytesToHex(keccak256(hexToBytes(rawTransaction, "rawTransaction")))}`,
    };
  }
}

/** Produce a canonical 65-byte `r || s || v` EVM ECDSA signature. */
function signEvmDigest(digest: Uint8Array, privateKey: Uint8Array): Uint8Array {
  const sig = secp256k1.sign(digest, privateKey, { prehash: false, format: "recovered" });
  // `@noble/curves` returns `[recovery, r, s]`; convert to canonical `[r, s, v]`.
  const out = new Uint8Array(65);
  out.set(sig.slice(1), 0);
  out[64] = sig[0] === 0 ? 27 : 28;
  return out;
}

/**
 * Build a viem-compatible signature object for the parsed transaction's type.
 *
 * EIP-155 legacy transactions are serialized with `{ r, s, v }` where
 * `v = 35 + chainId * 2 + yParity`. Pre-EIP-155 legacy transactions are not
 * supported. All typed transactions (EIP-1559, EIP-2930, EIP-4844, …) are
 * serialized with `{ r, s, yParity }`.
 */
function buildSignature(
  parsed: { type?: string; chainId?: number },
  sig: Uint8Array,
): { r: Hex; s: Hex; yParity: 0 | 1 } | { r: Hex; s: Hex; v: bigint } {
  const r = `0x${bytesToHex(sig.slice(0, 32))}` as Hex;
  const s = `0x${bytesToHex(sig.slice(32, 64))}` as Hex;
  const yParity: 0 | 1 = sig[64] === 27 ? 0 : 1;

  if (parsed.type === "legacy") {
    if (parsed.chainId === undefined) {
      throw new Error("legacy transactions must include an EIP-155 chainId");
    }
    return { r, s, v: BigInt(35 + parsed.chainId * 2 + yParity) };
  }
  return { r, s, yParity };
}
