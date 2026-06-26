import { encodeFunctionData, serializeTransaction, toFunctionSelector, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { EthereumVmTransaction } from "../../src/common/types.js";
import { verifyTransactionsWithWallet } from "../../src/derivation/index.js";
import { DEPOSITORY, DEPOSITOR, makeAttestation, makeTrigger, ORDER_ID } from "./shared.js";

const DEPOSIT_NATIVE_ABI = [
  {
    type: "function",
    name: "depositNative",
    stateMutability: "payable",
    inputs: [
      { name: "depositor", type: "address" },
      { name: "orderId", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;
const DEPOSIT_NATIVE_SELECTOR = toFunctionSelector(
  "function depositNative(address depositor, bytes32 orderId)",
);

const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const DEPOSIT_ERC20_ABI = [
  {
    type: "function",
    name: "depositErc20",
    stateMutability: "nonpayable",
    inputs: [
      { name: "depositor", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "orderId", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;
const DEPOSIT_ERC20_SELECTOR = toFunctionSelector(
  "function depositErc20(address depositor, address token, uint256 amount, bytes32 orderId)",
);
const TOKEN_ADDRESS = "0x000000000000000000000000000000000000aaaa";
const INPUT_AMOUNT = 1_000_000_000_000_000n;

interface BuildTxOptions {
  to?: string;
  data?: Hex;
  value?: bigint;
  chainId?: number;
}

function buildTx(opts: BuildTxOptions = {}): EthereumVmTransaction {
  const data =
    opts.data ??
    encodeFunctionData({
      abi: DEPOSIT_NATIVE_ABI,
      functionName: "depositNative",
      args: [DEPOSITOR, ORDER_ID],
    });
  const unsignedTransaction = serializeTransaction({
    type: "eip1559",
    chainId: opts.chainId ?? 10,
    to: (opts.to ?? DEPOSITORY) as `0x${string}`,
    value: opts.value ?? 1_000_000_000_000_000n,
    data,
    nonce: 0,
    gas: 100_000n,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 100_000_000n,
  });
  return { unsignedTransaction };
}

describe("ethereum-vm transaction policy", () => {
  it("accepts a depositNative call to the input depository", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeTrigger(), makeAttestation(), [buildTx()]),
    ).not.toThrow();
  });

  it("rejects a native deposit batch with more than one transaction", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeTrigger(), makeAttestation(), [buildTx(), buildTx()]),
    ).toThrow(/native deposit requires exactly 1 transaction/);
  });

  it("rejects a native deposit whose value does not equal input.amount", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeTrigger(), makeAttestation(), [
        buildTx({ value: INPUT_AMOUNT - 1n }),
      ]),
    ).toThrow(/value must equal input\.amount: expected=1000000000000000, got=999999999999999/);
  });

  it("rejects a tx whose `to` is not the input depository", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeTrigger(), makeAttestation(), [
        buildTx({ to: "0x000000000000000000000000000000000000dead" }),
      ]),
    ).toThrow(/"to" must equal input depository/);
  });

  it("rejects a tx with a non-depositNative selector", () => {
    // function transfer(address,uint256) -> selector 0xa9059cbb
    const transferData =
      "0xa9059cbb000000000000000000000000000000000000000000000000000000000000beef0000000000000000000000000000000000000000000000000000000000000001" as Hex;
    expect(() =>
      verifyTransactionsWithWallet(makeTrigger(), makeAttestation(), [
        buildTx({ data: transferData }),
      ]),
    ).toThrow(new RegExp(`data must call depositNative.*${DEPOSIT_NATIVE_SELECTOR}`));
  });

  it("rejects a depositNative call whose `depositor` arg doesn't match derivationFields.depositor", () => {
    const wrongDepositor = encodeFunctionData({
      abi: DEPOSIT_NATIVE_ABI,
      functionName: "depositNative",
      args: ["0x000000000000000000000000000000000000dead", ORDER_ID],
    });
    expect(() =>
      verifyTransactionsWithWallet(makeTrigger(), makeAttestation(), [
        buildTx({ data: wrongDepositor }),
      ]),
    ).toThrow(/depositNative\.depositor mismatch/);
  });

  it("rejects a depositNative call whose `orderId` arg doesn't match trigger.orderId", () => {
    const wrongOrderId = encodeFunctionData({
      abi: DEPOSIT_NATIVE_ABI,
      functionName: "depositNative",
      args: [DEPOSITOR, `0x${"99".repeat(32)}`],
    });
    expect(() =>
      verifyTransactionsWithWallet(makeTrigger(), makeAttestation(), [
        buildTx({ data: wrongOrderId }),
      ]),
    ).toThrow(/depositNative\.orderId mismatch/);
  });

  it("rejects a plain native transfer with empty calldata", () => {
    // Exactly the shape of the previous unconditional sweep transaction
    // (value transfer, no calldata). The policy must reject it now.
    expect(() =>
      verifyTransactionsWithWallet(makeTrigger(), makeAttestation(), [buildTx({ data: "0x" })]),
    ).toThrow(/data must call depositNative/);
  });

  it("accepts a checksummed/mixed-case input depository and depositor", () => {
    // attestation.inputDepository and derivationFields.depositor are bytes
    // fields, so callers may upper-case the hex. The verifier compares
    // lowercased, so this must still match.
    const trigger = makeTrigger();
    trigger.derivationFields.depositor = DEPOSITOR.toUpperCase().replace("0X", "0x");
    const attestation = makeAttestation();
    attestation.inputDepository = DEPOSITORY.toUpperCase().replace("0X", "0x");
    expect(() => verifyTransactionsWithWallet(trigger, attestation, [buildTx()])).not.toThrow();
  });

  it("accepts a legacy (type-0, EIP-155) depositNative tx", () => {
    const data = encodeFunctionData({
      abi: DEPOSIT_NATIVE_ABI,
      functionName: "depositNative",
      args: [DEPOSITOR, ORDER_ID],
    });
    const unsignedTransaction = serializeTransaction({
      type: "legacy",
      chainId: 10,
      to: DEPOSITORY as `0x${string}`,
      value: 1_000_000_000_000_000n,
      data,
      nonce: 0,
      gas: 100_000n,
      gasPrice: 1_000_000_000n,
    });
    expect(() =>
      verifyTransactionsWithWallet(makeTrigger(), makeAttestation(), [{ unsignedTransaction }]),
    ).not.toThrow();
  });
});

describe("ethereum-vm transaction policy (ERC-20 deposits)", () => {
  function buildApproveTx(
    overrides: {
      to?: string;
      spender?: string;
      value?: bigint;
      txValue?: bigint;
      chainId?: number;
    } = {},
  ): EthereumVmTransaction {
    const data = encodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      functionName: "approve",
      args: [(overrides.spender ?? DEPOSITORY) as `0x${string}`, overrides.value ?? INPUT_AMOUNT],
    });
    return buildTx({
      to: overrides.to ?? TOKEN_ADDRESS,
      data,
      value: overrides.txValue ?? 0n,
      chainId: overrides.chainId,
    });
  }

  function buildDepositErc20Tx(
    overrides: {
      to?: string;
      depositor?: string;
      token?: string;
      amount?: bigint;
      orderId?: Hex;
      value?: bigint;
      chainId?: number;
    } = {},
  ): EthereumVmTransaction {
    const data = encodeFunctionData({
      abi: DEPOSIT_ERC20_ABI,
      functionName: "depositErc20",
      args: [
        (overrides.depositor ?? DEPOSITOR) as `0x${string}`,
        (overrides.token ?? TOKEN_ADDRESS) as `0x${string}`,
        overrides.amount ?? INPUT_AMOUNT,
        overrides.orderId ?? ORDER_ID,
      ],
    });
    return buildTx({
      to: overrides.to ?? DEPOSITORY,
      data,
      value: overrides.value ?? 0n,
      chainId: overrides.chainId,
    });
  }

  const erc20Trigger = () => makeTrigger({ inputCurrency: TOKEN_ADDRESS });

  it("accepts a well-formed approve + depositErc20 batch", () => {
    expect(() =>
      verifyTransactionsWithWallet(erc20Trigger(), makeAttestation(), [
        buildApproveTx(),
        buildDepositErc20Tx(),
      ]),
    ).not.toThrow();
  });

  it("rejects an erc-20 batch with the wrong transaction count", () => {
    expect(() =>
      verifyTransactionsWithWallet(erc20Trigger(), makeAttestation(), [buildDepositErc20Tx()]),
    ).toThrow(/erc-20 deposit requires exactly 2 transactions/);
  });

  it("rejects an approve whose `to` is not the token contract", () => {
    expect(() =>
      verifyTransactionsWithWallet(erc20Trigger(), makeAttestation(), [
        buildApproveTx({ to: "0x000000000000000000000000000000000000dead" }),
        buildDepositErc20Tx(),
      ]),
    ).toThrow(/transactions\[0\]: "to" must equal input\.currency \(token\)/);
  });

  it("rejects an approve whose selector is wrong", () => {
    expect(() =>
      verifyTransactionsWithWallet(erc20Trigger(), makeAttestation(), [
        buildTx({ to: TOKEN_ADDRESS, data: "0xdeadbeef" as Hex, value: 0n }),
        buildDepositErc20Tx(),
      ]),
    ).toThrow(/transactions\[0\]: data must call approve\(address,uint256\)/);
  });

  it("rejects an approve whose spender is not the input depository", () => {
    expect(() =>
      verifyTransactionsWithWallet(erc20Trigger(), makeAttestation(), [
        buildApproveTx({ spender: "0x000000000000000000000000000000000000dead" }),
        buildDepositErc20Tx(),
      ]),
    ).toThrow(/transactions\[0\]: approve\.spender mismatch/);
  });

  it("rejects an ERC-20 approve transaction with non-zero native value", () => {
    expect(() =>
      verifyTransactionsWithWallet(erc20Trigger(), makeAttestation(), [
        buildApproveTx({ txValue: 1n }),
        buildDepositErc20Tx(),
      ]),
    ).toThrow(/transactions\[0\]: value must be zero for ERC-20 deposits, got=1/);
  });

  it("rejects an approve whose value is not input.amount", () => {
    expect(() =>
      verifyTransactionsWithWallet(erc20Trigger(), makeAttestation(), [
        buildApproveTx({ value: INPUT_AMOUNT - 1n }),
        buildDepositErc20Tx(),
      ]),
    ).toThrow(/transactions\[0\]: approve\.value mismatch/);
  });

  it("rejects an ERC-20 deposit transaction with non-zero native value", () => {
    expect(() =>
      verifyTransactionsWithWallet(erc20Trigger(), makeAttestation(), [
        buildApproveTx(),
        buildDepositErc20Tx({ value: 1n }),
      ]),
    ).toThrow(/transactions\[1\]: value must be zero for ERC-20 deposits, got=1/);
  });

  it("rejects a depositErc20 whose `to` is not the input depository", () => {
    expect(() =>
      verifyTransactionsWithWallet(erc20Trigger(), makeAttestation(), [
        buildApproveTx(),
        buildDepositErc20Tx({ to: "0x000000000000000000000000000000000000dead" }),
      ]),
    ).toThrow(/transactions\[1\]: "to" must equal input depository/);
  });

  it("rejects a depositErc20 with a non-depositErc20 selector", () => {
    expect(() =>
      verifyTransactionsWithWallet(erc20Trigger(), makeAttestation(), [
        buildApproveTx(),
        buildTx({ to: DEPOSITORY, data: "0xdeadbeef" as Hex, value: 0n }),
      ]),
    ).toThrow(
      new RegExp(`transactions\\[1\\]: data must call depositErc20.*${DEPOSIT_ERC20_SELECTOR}`),
    );
  });

  it("rejects a depositErc20 whose depositor doesn't match derivationFields.depositor", () => {
    expect(() =>
      verifyTransactionsWithWallet(erc20Trigger(), makeAttestation(), [
        buildApproveTx(),
        buildDepositErc20Tx({ depositor: "0x000000000000000000000000000000000000dead" }),
      ]),
    ).toThrow(/transactions\[1\]: depositErc20\.depositor mismatch/);
  });

  it("rejects a depositErc20 whose token doesn't match input.currency", () => {
    expect(() =>
      verifyTransactionsWithWallet(erc20Trigger(), makeAttestation(), [
        buildApproveTx(),
        buildDepositErc20Tx({ token: "0x000000000000000000000000000000000000bbbb" }),
      ]),
    ).toThrow(/transactions\[1\]: depositErc20\.token mismatch/);
  });

  it("rejects a depositErc20 whose amount doesn't match input.amount", () => {
    expect(() =>
      verifyTransactionsWithWallet(erc20Trigger(), makeAttestation(), [
        buildApproveTx(),
        buildDepositErc20Tx({ amount: INPUT_AMOUNT - 1n }),
      ]),
    ).toThrow(/transactions\[1\]: depositErc20\.amount mismatch/);
  });

  it("rejects a depositErc20 whose orderId doesn't match trigger.orderId", () => {
    expect(() =>
      verifyTransactionsWithWallet(erc20Trigger(), makeAttestation(), [
        buildApproveTx(),
        buildDepositErc20Tx({ orderId: `0x${"99".repeat(32)}` }),
      ]),
    ).toThrow(/transactions\[1\]: depositErc20\.orderId mismatch/);
  });
});
