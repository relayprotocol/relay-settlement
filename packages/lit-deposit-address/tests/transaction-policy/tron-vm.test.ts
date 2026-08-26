import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { encodeTronAddress } from "../../src/common/address/tron.js";
import { bytesToHex } from "../../src/common/bytes.js";
import type {
  DepositAddressTrigger,
  DepositAddressTriggerAttestation,
  TronVmTransaction,
} from "../../src/common/types.js";
import { verifyTransactionsWithWallet } from "../../src/derivation/index.js";
import { makeAttestation, makeTrigger, ORDER_ID } from "./shared.js";
import {
  buildTransferTransaction,
  buildTriggerContractTransaction,
  OTHER_TRON_ADDRESS,
  TRON_DEPOSITORY,
  TRON_TOKEN,
} from "../transactions/tron-helpers.js";

const DEPOSITORY_ABI = parseAbi([
  "function depositNative(address depositor, bytes32 id)",
  "function depositErc20(address depositor, address token, uint256 amount, bytes32 id)",
]);
const ERC20_ABI = parseAbi(["function approve(address spender, uint256 amount)"]);
const AMOUNT = 1_000_000n;
const NATIVE_CURRENCY = "0x410000000000000000000000000000000000000000";
const DEPOSITOR = TRON_TOKEN;

/** Encode a canonical Tron address in the settlement SDK's bytes format. */
function encodedAddress(address: string): string {
  return `0x${bytesToHex(encodeTronAddress(address))}`;
}

/** Convert a Tron address to the 20-byte address expected by the TVM ABI. */
function abiAddress(address: string): Address {
  return `0x${bytesToHex(encodeTronAddress(address).slice(1))}`;
}

/** Build a Tron trigger whose byte-address fields match the transaction fixtures. */
function tronTrigger(currency = NATIVE_CURRENCY): DepositAddressTrigger {
  const trigger = makeTrigger({ inputCurrency: currency, inputVmType: "tron-vm" });
  trigger.input.amount = AMOUNT.toString();
  trigger.derivationFields.depositor = encodedAddress(DEPOSITOR);
  return trigger;
}

/** Build a Tron attestation with its depository encoded as protocol bytes. */
function tronAttestation(): DepositAddressTriggerAttestation {
  return { ...makeAttestation(), inputDepository: encodedAddress(TRON_DEPOSITORY) };
}

/** Build the exact TVM calldata for depositNative. */
function nativeData(overrides: { depositor?: string; orderId?: string } = {}): string {
  return encodeFunctionData({
    abi: DEPOSITORY_ABI,
    functionName: "depositNative",
    args: [abiAddress(overrides.depositor ?? DEPOSITOR), (overrides.orderId ?? ORDER_ID) as Hex],
  }).slice(2);
}

/** Build the exact TVM calldata for approve. */
function approveData(amount: bigint): string {
  return encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [abiAddress(TRON_DEPOSITORY), amount],
  }).slice(2);
}

/** Build the exact TVM calldata for depositErc20. */
function depositTrc20Data(overrides: { token?: string; amount?: bigint } = {}): string {
  return encodeFunctionData({
    abi: DEPOSITORY_ABI,
    functionName: "depositErc20",
    args: [
      abiAddress(DEPOSITOR),
      abiAddress(overrides.token ?? TRON_TOKEN),
      overrides.amount ?? AMOUNT,
      ORDER_ID,
    ],
  }).slice(2);
}

/** Build a policy-valid native deposit transaction. */
function nativeTransaction(
  overrides: Partial<Parameters<typeof buildTriggerContractTransaction>[0]> = {},
): TronVmTransaction {
  return buildTriggerContractTransaction({
    purpose: "native-deposit",
    owner: DEPOSITOR,
    contractAddress: TRON_DEPOSITORY,
    callValue: AMOUNT,
    data: nativeData(),
    ...overrides,
  });
}

/** Build one policy-valid TRC20 stage. */
function trc20Transaction(
  purpose: "trc20-pre-approval" | "trc20-approval" | "trc20-deposit",
): TronVmTransaction {
  if (purpose === "trc20-pre-approval") {
    return buildTriggerContractTransaction({
      purpose,
      owner: DEPOSITOR,
      contractAddress: TRON_TOKEN,
      data: approveData(0n),
    });
  }
  if (purpose === "trc20-approval") {
    return buildTriggerContractTransaction({
      purpose,
      owner: DEPOSITOR,
      contractAddress: TRON_TOKEN,
      data: approveData(AMOUNT),
    });
  }
  return buildTriggerContractTransaction({
    purpose,
    owner: DEPOSITOR,
    contractAddress: TRON_DEPOSITORY,
    data: depositTrc20Data(),
  });
}

describe("tron-vm transaction policy", () => {
  it("matches the established TVM calldata vectors", () => {
    expect(nativeData()).toBe(
      "49290c1c0000000000000000000000007e5f4552091a69125d5dfcb7b8c2659029395bdfabababababababababababababababababababababababababababababababab",
    );
    expect(approveData(AMOUNT)).toBe(
      "095ea7b3000000000000000000000000f0623e1012177482912fb057e44e1a9769b1f58800000000000000000000000000000000000000000000000000000000000f4240",
    );
    expect(depositTrc20Data()).toBe(
      "e80179520000000000000000000000007e5f4552091a69125d5dfcb7b8c2659029395bdf0000000000000000000000007e5f4552091a69125d5dfcb7b8c2659029395bdf00000000000000000000000000000000000000000000000000000000000f4240abababababababababababababababababababababababababababababababab",
    );
  });

  it("accepts one exact native deposit", () => {
    expect(() =>
      verifyTransactionsWithWallet(tronTrigger(), tronAttestation(), [nativeTransaction()]),
    ).not.toThrow();
  });

  it("accepts approval then TRC20 deposit", () => {
    expect(() =>
      verifyTransactionsWithWallet(
        tronTrigger(encodedAddress(TRON_TOKEN)),
        tronAttestation(),
        [trc20Transaction("trc20-approval"), trc20Transaction("trc20-deposit")],
      ),
    ).not.toThrow();
  });

  it("accepts allowance reset, approval, then TRC20 deposit", () => {
    expect(() =>
      verifyTransactionsWithWallet(
        tronTrigger(encodedAddress(TRON_TOKEN)),
        tronAttestation(),
        [
          trc20Transaction("trc20-pre-approval"),
          trc20Transaction("trc20-approval"),
          trc20Transaction("trc20-deposit"),
        ],
      ),
    ).not.toThrow();
  });

  it("rejects a direct TRX transfer to the Solver wallet", () => {
    expect(() =>
      verifyTransactionsWithWallet(
        tronTrigger(),
        tronAttestation(),
        [buildTransferTransaction({ owner: DEPOSITOR, amount: 12n })],
      ),
    ).toThrow("native Tron deposit requires exactly one native-deposit transaction");
  });

  it("defers owner validation to transaction signing", () => {
    expect(() =>
      verifyTransactionsWithWallet(
        tronTrigger(),
        tronAttestation(),
        [nativeTransaction({ owner: OTHER_TRON_ADDRESS })],
      ),
    ).not.toThrow();
  });

  it("rejects a changed native depository", () => {
    expect(() =>
      verifyTransactionsWithWallet(
        tronTrigger(),
        tronAttestation(),
        [nativeTransaction({ contractAddress: TRON_TOKEN })],
      ),
    ).toThrow("input depository");
  });

  it("rejects a changed native amount", () => {
    expect(() =>
      verifyTransactionsWithWallet(
        tronTrigger(),
        tronAttestation(),
        [nativeTransaction({ callValue: AMOUNT - 1n })],
      ),
    ).toThrow("call_value must equal input.amount");
  });

  it("rejects changed native calldata", () => {
    expect(() =>
      verifyTransactionsWithWallet(
        tronTrigger(),
        tronAttestation(),
        [nativeTransaction({ data: nativeData({ depositor: OTHER_TRON_ADDRESS }) })],
      ),
    ).toThrow("depositNative calldata mismatch");
  });

  it("rejects a changed order id", () => {
    expect(() =>
      verifyTransactionsWithWallet(
        tronTrigger(),
        tronAttestation(),
        [nativeTransaction({ data: nativeData({ orderId: `0x${"ff".repeat(32)}` }) })],
      ),
    ).toThrow("depositNative calldata mismatch");
  });

  it("rejects a transaction containing multiple contracts", () => {
    expect(() =>
      verifyTransactionsWithWallet(
        tronTrigger(),
        tronAttestation(),
        [nativeTransaction({ duplicateContract: true })],
      ),
    ).toThrow("Tron raw_data is not canonical");
  });

  it("rejects reordered TRC20 stages", () => {
    expect(() =>
      verifyTransactionsWithWallet(
        tronTrigger(encodedAddress(TRON_TOKEN)),
        tronAttestation(),
        [trc20Transaction("trc20-deposit"), trc20Transaction("trc20-approval")],
      ),
    ).toThrow("TRC20 transaction purposes");
  });

  it("rejects a duplicate TRC20 stage", () => {
    expect(() =>
      verifyTransactionsWithWallet(
        tronTrigger(encodedAddress(TRON_TOKEN)),
        tronAttestation(),
        [trc20Transaction("trc20-approval"), trc20Transaction("trc20-approval")],
      ),
    ).toThrow("TRC20 transaction purposes");
  });

  it("rejects an approval for a different token", () => {
    const approval = buildTriggerContractTransaction({
      purpose: "trc20-approval",
      owner: DEPOSITOR,
      contractAddress: OTHER_TRON_ADDRESS,
      data: approveData(AMOUNT),
    });
    expect(() =>
      verifyTransactionsWithWallet(
        tronTrigger(encodedAddress(TRON_TOKEN)),
        tronAttestation(),
        [approval, trc20Transaction("trc20-deposit")],
      ),
    ).toThrow("approval token mismatch");
  });

  it("rejects an approval for a different amount", () => {
    const approval = buildTriggerContractTransaction({
      purpose: "trc20-approval",
      owner: DEPOSITOR,
      contractAddress: TRON_TOKEN,
      data: approveData(AMOUNT - 1n),
    });
    expect(() =>
      verifyTransactionsWithWallet(
        tronTrigger(encodedAddress(TRON_TOKEN)),
        tronAttestation(),
        [approval, trc20Transaction("trc20-deposit")],
      ),
    ).toThrow("approve calldata mismatch");
  });

  it("rejects an allowance reset to a non-zero amount", () => {
    const preApproval = buildTriggerContractTransaction({
      purpose: "trc20-pre-approval",
      owner: DEPOSITOR,
      contractAddress: TRON_TOKEN,
      data: approveData(1n),
    });
    expect(() =>
      verifyTransactionsWithWallet(
        tronTrigger(encodedAddress(TRON_TOKEN)),
        tronAttestation(),
        [preApproval, trc20Transaction("trc20-approval"), trc20Transaction("trc20-deposit")],
      ),
    ).toThrow("approve calldata mismatch");
  });

  it("rejects a TRC20 deposit with a different token argument", () => {
    const deposit = buildTriggerContractTransaction({
      purpose: "trc20-deposit",
      owner: DEPOSITOR,
      contractAddress: TRON_DEPOSITORY,
      data: depositTrc20Data({ token: OTHER_TRON_ADDRESS }),
    });
    expect(() =>
      verifyTransactionsWithWallet(
        tronTrigger(encodedAddress(TRON_TOKEN)),
        tronAttestation(),
        [trc20Transaction("trc20-approval"), deposit],
      ),
    ).toThrow("depositErc20 calldata mismatch");
  });

  it("rejects a TRC20 deposit with a different amount argument", () => {
    const deposit = buildTriggerContractTransaction({
      purpose: "trc20-deposit",
      owner: DEPOSITOR,
      contractAddress: TRON_DEPOSITORY,
      data: depositTrc20Data({ amount: AMOUNT - 1n }),
    });
    expect(() =>
      verifyTransactionsWithWallet(
        tronTrigger(encodedAddress(TRON_TOKEN)),
        tronAttestation(),
        [trc20Transaction("trc20-approval"), deposit],
      ),
    ).toThrow("depositErc20 calldata mismatch");
  });

  it("rejects a non-zero TRC20 call value", () => {
    const deposit = buildTriggerContractTransaction({
      purpose: "trc20-deposit",
      owner: DEPOSITOR,
      contractAddress: TRON_DEPOSITORY,
      callValue: 1n,
      data: depositTrc20Data(),
    });
    expect(() =>
      verifyTransactionsWithWallet(
        tronTrigger(encodedAddress(TRON_TOKEN)),
        tronAttestation(),
        [trc20Transaction("trc20-approval"), deposit],
      ),
    ).toThrow("depositErc20 call_value must be zero");
  });

  it("rejects an expired transaction", () => {
    const timestamp = Date.now() - 120_000;
    expect(() =>
      verifyTransactionsWithWallet(
        tronTrigger(),
        tronAttestation(),
        [nativeTransaction({ timestamp, expiration: timestamp + 60_000 })],
      ),
    ).toThrow("transaction is expired");
  });

  it("rejects an unbounded expiration", () => {
    const timestamp = Date.now();
    expect(() =>
      verifyTransactionsWithWallet(
        tronTrigger(),
        tronAttestation(),
        [nativeTransaction({ timestamp, expiration: timestamp + 3_600_001 })],
      ),
    ).toThrow("expiration exceeds");
  });
});
