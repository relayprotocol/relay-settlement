import { encodeFunctionData, serializeTransaction, toFunctionSelector, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import type {
  DepositAddressTrigger,
  DepositAddressTriggerAttestation,
  BitcoinVmTransaction,
  EthereumVmTransaction,
  HyperliquidVmTransaction,
  VmType,
} from "../src/common/types.js";
import { verifyTransactionsWithWallet } from "../src/derivation/index.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEPOSITORY = "0x00000000000000000000000000000000000000ff";
const DEPOSITOR = "0x000000000000000000000000000000000000beef";
const ORDER_ID: Hex = `0x${"ab".repeat(32)}`;

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

function makeTrigger(
  overrides: { inputCurrency?: string; inputVmType?: VmType } = {},
): DepositAddressTrigger {
  const inputVmType = overrides.inputVmType ?? "ethereum-vm";
  return {
    input: {
      vmType: inputVmType,
      chainId: "10",
      currency: overrides.inputCurrency ?? ZERO_ADDRESS,
      amount: "1000000000000000",
    },
    derivationFields: {
      inputVmType,
      outputVmType: "ethereum-vm",
      outputChainId: "base",
      outputCurrency: ZERO_ADDRESS,
      outputRecipient: "0x000000000000000000000000000000000000dead",
      solver: "0x000000000000000000000000000000000000cafe",
      pricingOracle: "0x000000000000000000000000000000000000beef",
      depositor: DEPOSITOR,
      refundRecipient: DEPOSITOR,
      priceImpactBps: "200",
    },
    orderId: ORDER_ID,
    nonce: "1",
    currencies: [],
    prices: [],
    extraData: "0x",
  };
}

function makeAttestation(): DepositAddressTriggerAttestation {
  return {
    chainId: 421614,
    depositAddressManager: "0xd03250b221f709abe58ff4a177d50d01d922d974",
    inputDepository: DEPOSITORY,
    triggerHash: `0x${"00".repeat(32)}`,
    signatures: [],
  };
}

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

  it("rejects a native deposit whose transaction chainId does not equal input.chainId", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeTrigger(), makeAttestation(), [buildTx({ chainId: 1 })]),
    ).toThrow(/transactions\[0\]: chainId mismatch: expected=10, got=1/);
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

  it("rejects an ERC-20 approve whose transaction chainId does not equal input.chainId", () => {
    expect(() =>
      verifyTransactionsWithWallet(erc20Trigger(), makeAttestation(), [
        buildApproveTx({ chainId: 1 }),
        buildDepositErc20Tx(),
      ]),
    ).toThrow(/transactions\[0\]: chainId mismatch: expected=10, got=1/);
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

describe("bitcoin-vm transaction policy", () => {
  const BITCOIN_NATIVE_CURRENCY = `0x${"00".repeat(20)}`;
  const BITCOIN_DEPOSITORY_ENCODED = `0x00${"11".repeat(20)}`;
  const BITCOIN_DEPOSITORY_SCRIPT = `0014${"11".repeat(20)}`;
  const BITCOIN_REFUND_ENCODED = `0x00${"33".repeat(20)}`;
  const BITCOIN_REFUND_SCRIPT = `0014${"33".repeat(20)}`;
  const BITCOIN_DEPOSITOR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
  const BITCOIN_DEPOSITOR_ENCODED = "0xff0062e907b15cbf27d5425399ebf6f0fb50ebb88f18";
  const BITCOIN_AMOUNT = 50_000n;

  function bitcoinTrigger(overrides: { amount?: bigint; depositor?: string } = {}) {
    const trigger = makeTrigger({
      inputVmType: "bitcoin-vm",
      inputCurrency: BITCOIN_NATIVE_CURRENCY,
    });
    trigger.input.amount = (overrides.amount ?? BITCOIN_AMOUNT).toString();
    trigger.derivationFields.depositor = overrides.depositor ?? BITCOIN_DEPOSITOR_ENCODED;
    trigger.derivationFields.refundRecipient = BITCOIN_REFUND_ENCODED;
    return trigger;
  }

  function bitcoinAttestation() {
    return { ...makeAttestation(), inputDepository: BITCOIN_DEPOSITORY_ENCODED };
  }

  function buildBitcoinTx(
    opts: {
      amount?: bigint;
      orderId?: string;
      depositor?: string;
      witness?: string;
      changeScript?: string;
    } = {},
  ): BitcoinVmTransaction {
    const amount = opts.amount ?? BITCOIN_AMOUNT;
    const orderId = opts.orderId ?? ORDER_ID;
    const depositor = opts.depositor ?? BITCOIN_DEPOSITOR;
    const metadata = Buffer.from(`${orderId}|depositor=${depositor}|`, "utf8").toString("hex");
    const isSegwit = opts.witness !== undefined;
    const changeScript = opts.changeScript;
    const outputs = [
      amount.toString(16).padStart(16, "0").match(/../gu)!.reverse().join(""),
      `${(BITCOIN_DEPOSITORY_SCRIPT.length / 2).toString(16).padStart(2, "0")}${BITCOIN_DEPOSITORY_SCRIPT}`,
      ...(changeScript
        ? [
            "0100000000000000",
            `${(changeScript.length / 2).toString(16).padStart(2, "0")}${changeScript}`,
          ]
        : []),
      "0000000000000000",
      `${(1 + 2 + metadata.length / 2).toString(16).padStart(2, "0")}6a4c${(metadata.length / 2)
        .toString(16)
        .padStart(2, "0")}${metadata}`,
    ];
    const unsignedTransaction =
      "0x" +
      [
        "01000000", // version
        isSegwit ? "0001" : "", // segwit marker + flag
        "01", // input count
        "22".repeat(32), // previous txid (little-endian bytes)
        "00000000", // previous output index
        "00", // empty scriptSig
        "fdffffff", // sequence
        (outputs.length / 2).toString(16).padStart(2, "0"), // output count
        ...outputs,
        opts.witness ?? "", // one witness stack per input when segwit marker is present
        "00000000", // locktime
      ].join("");
    return { unsignedTransaction, inputValues: ["60000"], sighashes: [`0x${"00".repeat(32)}`] };
  }

  it("accepts a native BTC deposit with orderId and explicit depositor metadata", () => {
    expect(() =>
      verifyTransactionsWithWallet(bitcoinTrigger(), bitcoinAttestation(), [buildBitcoinTx()]),
    ).not.toThrow();
  });

  it("accepts a segwit-flagged unsigned BTC deposit with an empty witness", () => {
    expect(() =>
      verifyTransactionsWithWallet(bitcoinTrigger(), bitcoinAttestation(), [
        buildBitcoinTx({ witness: "00" }),
      ]),
    ).not.toThrow();
  });

  it("rejects a segwit-flagged unsigned BTC deposit with a non-empty witness", () => {
    expect(() =>
      verifyTransactionsWithWallet(bitcoinTrigger(), bitcoinAttestation(), [
        buildBitcoinTx({ witness: "010100" }),
      ]),
    ).toThrow(/witness\[0\] must be empty/);
  });

  it("accepts a native BTC deposit with change to refundRecipient", () => {
    expect(() =>
      verifyTransactionsWithWallet(bitcoinTrigger(), bitcoinAttestation(), [
        buildBitcoinTx({ changeScript: BITCOIN_REFUND_SCRIPT }),
      ]),
    ).not.toThrow();
  });

  it("rejects a native BTC deposit with change to an unexpected script", () => {
    expect(() =>
      verifyTransactionsWithWallet(bitcoinTrigger(), bitcoinAttestation(), [
        buildBitcoinTx({ changeScript: `0014${"44".repeat(20)}` }),
      ]),
    ).toThrow(/non-depository, non-OP_RETURN outputs must pay/);
  });

  it("rejects a deposit whose depository output amount does not match input.amount", () => {
    expect(() =>
      verifyTransactionsWithWallet(bitcoinTrigger(), bitcoinAttestation(), [
        buildBitcoinTx({ amount: BITCOIN_AMOUNT - 1n }),
      ]),
    ).toThrow(/value sent to input depository must equal input\.amount/);
  });

  it("rejects a deposit without the trigger order id in OP_RETURN", () => {
    expect(() =>
      verifyTransactionsWithWallet(bitcoinTrigger(), bitcoinAttestation(), [
        buildBitcoinTx({ orderId: `0x${"cd".repeat(32)}` }),
      ]),
    ).toThrow(/OP_RETURN metadata must start with trigger\.orderId/);
  });

  it("rejects a deposit whose explicit OP_RETURN depositor differs from derivation fields", () => {
    expect(() =>
      verifyTransactionsWithWallet(bitcoinTrigger(), bitcoinAttestation(), [
        buildBitcoinTx({ depositor: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT" }),
      ]),
    ).toThrow(/OP_RETURN depositor mismatch/);
  });
});

// ─── hyperliquid-vm transaction policy ──────────────────────────────────────

describe("hyperliquid-vm transaction policy", () => {
  const HL_NATIVE = `0x${"00".repeat(16)}`;
  const HL_TOKEN = "0x6d1e7cde53ba9467b783cb7c530ce054";
  const HL_DEPOSITORY = "0x00000000000000000000000000000000000000dd";
  const HL_DEPOSITOR = "0x0000000000000000000000000000000000000abc";
  const HL_WALLET = "0x0000000000000000000000000000000000000def";

  function hyperTrigger(currency = HL_NATIVE): DepositAddressTrigger {
    const trigger = makeTrigger({ inputVmType: "hyperliquid-vm", inputCurrency: currency });
    trigger.input.chainId = "hyperliquid-mainnet";
    trigger.input.amount = "123456789";
    trigger.derivationFields.depositor = HL_DEPOSITOR;
    trigger.currencies = [{ chainId: trigger.input.chainId, currency }];
    trigger.prices = [
      { usdPrice: "100000000", usdPriceDecimals: 8, currencyDecimals: 8, expiration: "9999999999" },
    ];
    return trigger;
  }

  function hyperAttestation(): DepositAddressTriggerAttestation {
    return { ...makeAttestation(), inputDepository: HL_DEPOSITORY };
  }

  function hyperTx(
    overrides: Partial<HyperliquidVmTransaction["sendAsset"]> = {},
  ): HyperliquidVmTransaction {
    return {
      nonceMapping: {
        walletChainId: "hyperliquid-mainnet",
        wallet: HL_WALLET,
        depositor: HL_DEPOSITOR,
        id: ORDER_ID,
        nonce: "12345",
      },
      sendAsset: {
        type: "sendAsset",
        signatureChainId: "0xa4b1",
        hyperliquidChain: "Mainnet",
        destination: HL_DEPOSITORY,
        sourceDex: "",
        destinationDex: "",
        token: `USDC:${HL_TOKEN}`,
        amount: "1.23456789",
        fromSubAccount: "",
        nonce: 12345,
        ...overrides,
      },
    };
  }

  it("accepts one nonce mapping plus one native sendAsset", () => {
    expect(() =>
      verifyTransactionsWithWallet(hyperTrigger(), hyperAttestation(), [hyperTx()]),
    ).not.toThrow();
  });

  it("requires Mainnet sendAsset", () => {
    expect(() =>
      verifyTransactionsWithWallet(hyperTrigger(), hyperAttestation(), [
        hyperTx({ hyperliquidChain: "Testnet" as "Mainnet" }),
      ]),
    ).toThrow(/hyperliquidChain must be Mainnet/);
  });

  it("requires empty dexes for native currency", () => {
    expect(() =>
      verifyTransactionsWithWallet(hyperTrigger(), hyperAttestation(), [
        hyperTx({ sourceDex: "spot" }),
      ]),
    ).toThrow(/sourceDex\/destinationDex/);
  });

  it("requires spot dexes for non-native currency", () => {
    expect(() =>
      verifyTransactionsWithWallet(hyperTrigger(HL_TOKEN), hyperAttestation(), [hyperTx()]),
    ).toThrow(/sourceDex\/destinationDex/);
    expect(() =>
      verifyTransactionsWithWallet(hyperTrigger(HL_TOKEN), hyperAttestation(), [
        hyperTx({ sourceDex: "spot", destinationDex: "spot" }),
      ]),
    ).not.toThrow();
  });
});

// ─── solana-vm transaction policy ───────────────────────────────────────────

const SOLANA_DEPOSITORY_HEX = ("0x" + "11".repeat(32)) as `0x${string}`; // 32-byte program id (raw bytes hex)
const SOLANA_DEPOSITOR_HEX = ("0x" + "22".repeat(32)) as `0x${string}`;
const SOLANA_MINT_HEX = ("0x" + "33".repeat(32)) as `0x${string}`;
const SOLANA_ZERO_HEX = ("0x" + "00".repeat(32)) as `0x${string}`;
const SOLANA_ORDER_ID: `0x${string}` = ("0x" + "ab".repeat(32)) as `0x${string}`;
const SOLANA_INPUT_AMOUNT = 1_234_567n;

const DEPOSIT_NATIVE_DISCRIMINATOR_BYTES = new Uint8Array([
  0x0d, 0x9e, 0x0d, 0xdf, 0x5f, 0xd5, 0x1c, 0x06,
]);
const DEPOSIT_TOKEN_DISCRIMINATOR_BYTES = new Uint8Array([
  0x0b, 0x9c, 0x60, 0xda, 0x27, 0xa3, 0xb4, 0x13,
]);

function hexToBytes32(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length !== 64) {
    throw new Error(`expected 32 bytes hex, got ${clean.length / 2} bytes`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function encodeShortU16(value: number): Uint8Array {
  if (value < 0 || value > 0xffff) {
    throw new Error(`shortvec out of range: ${value}`);
  }
  if (value < 0x80) {
    return new Uint8Array([value]);
  }
  if (value < 0x4000) {
    return new Uint8Array([(value & 0x7f) | 0x80, (value >> 7) & 0x7f]);
  }
  return new Uint8Array([
    (value & 0x7f) | 0x80,
    ((value >> 7) & 0x7f) | 0x80,
    (value >> 14) & 0x03,
  ]);
}

function encodeU64LE(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) {
    total += a.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

/**
 * Build a base64-encoded legacy Solana compiled message containing exactly
 * one instruction. The instruction's `data` carries the Anchor discriminator
 * + Borsh-encoded `(amount, id)` args. `accountIndexes` is an array of
 * static-account-key indexes that the instruction references in Anchor order.
 */
interface SolanaMessageInputs {
  numRequiredSignatures?: number; // defaults to 1
  staticAccountKeys: Uint8Array[];
  instructions: Array<{
    programIdIndex: number;
    accountIndexes: number[];
    data: Uint8Array;
  }>;
}

function buildLegacyMessage(inputs: SolanaMessageInputs): string {
  const n = inputs.numRequiredSignatures ?? 1;
  // header: numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned.
  // numReadonlyUnsigned is the number of read-only non-signer accounts;
  // for our purposes it doesn't have to be exact, the verifier doesn't read
  // it.
  const header = new Uint8Array([n, 0, 1]);
  const numKeys = encodeShortU16(inputs.staticAccountKeys.length);
  const keys = concat(...inputs.staticAccountKeys);
  const blockhash = new Uint8Array(32); // zeros
  const numIxs = encodeShortU16(inputs.instructions.length);
  const ixs: Uint8Array[] = [];
  for (const ix of inputs.instructions) {
    const ixBytes = concat(
      new Uint8Array([ix.programIdIndex]),
      encodeShortU16(ix.accountIndexes.length),
      new Uint8Array(ix.accountIndexes),
      encodeShortU16(ix.data.length),
      ix.data,
    );
    ixs.push(ixBytes);
  }
  const out = concat(header, numKeys, keys, blockhash, numIxs, ...ixs);
  return Buffer.from(out).toString("base64");
}

function buildDepositArgs(
  discriminator: Uint8Array,
  amount: bigint,
  orderId: `0x${string}`,
): Uint8Array {
  return concat(discriminator, encodeU64LE(amount), hexToBytes32(orderId));
}

function makeSolanaTrigger(
  overrides: { inputCurrency?: `0x${string}` } = {},
): DepositAddressTrigger {
  return {
    ...makeTrigger({ inputVmType: "solana-vm", inputCurrency: overrides.inputCurrency }),
    input: {
      vmType: "solana-vm",
      chainId: "solana",
      currency: overrides.inputCurrency ?? SOLANA_ZERO_HEX,
      amount: SOLANA_INPUT_AMOUNT.toString(),
    },
    derivationFields: {
      ...makeTrigger({ inputVmType: "solana-vm" }).derivationFields,
      depositor: SOLANA_DEPOSITOR_HEX,
      refundRecipient: SOLANA_DEPOSITOR_HEX,
    },
    orderId: SOLANA_ORDER_ID,
  };
}

function makeSolanaAttestation(): DepositAddressTriggerAttestation {
  return { ...makeAttestation(), inputDepository: SOLANA_DEPOSITORY_HEX };
}

describe("solana-vm transaction policy (deposit_native)", () => {
  const signerKey = new Uint8Array(32).fill(0x42);
  const programKey = hexToBytes32(SOLANA_DEPOSITORY_HEX);
  const depositorKey = hexToBytes32(SOLANA_DEPOSITOR_HEX);
  const systemProgramKey = new Uint8Array(32); // 11111111111111111111111111111111
  const vaultKey = new Uint8Array(32).fill(0x99);
  const relayDepositoryPdaKey = new Uint8Array(32).fill(0x55);

  function buildNativeMessage(
    args: {
      amount?: bigint;
      orderId?: `0x${string}`;
      discriminator?: Uint8Array;
      accountIndexes?: number[];
      programIdIndex?: number;
      staticAccountKeys?: Uint8Array[];
      data?: Uint8Array;
      extraInstructions?: SolanaMessageInputs["instructions"];
      numRequiredSignatures?: number;
    } = {},
  ): string {
    const staticAccountKeys = args.staticAccountKeys ?? [
      signerKey, // 0: signer / sender
      depositorKey, // 1: depositor
      relayDepositoryPdaKey, // 2: relay_depository pda
      vaultKey, // 3: vault
      systemProgramKey, // 4: system program
      programKey, // 5: relay-depository program
    ];
    return buildLegacyMessage({
      numRequiredSignatures: args.numRequiredSignatures,
      staticAccountKeys,
      instructions: [
        {
          programIdIndex: args.programIdIndex ?? 5,
          accountIndexes: args.accountIndexes ?? [2, 0, 1, 3, 4],
          data:
            args.data ??
            buildDepositArgs(
              args.discriminator ?? DEPOSIT_NATIVE_DISCRIMINATOR_BYTES,
              args.amount ?? SOLANA_INPUT_AMOUNT,
              args.orderId ?? SOLANA_ORDER_ID,
            ),
        },
        ...(args.extraInstructions ?? []),
      ],
    });
  }

  it("accepts a well-formed deposit_native instruction", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeSolanaTrigger(), makeSolanaAttestation(), [
        { message: buildNativeMessage() },
      ]),
    ).not.toThrow();
  });

  it("rejects a batch with more than one transaction", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeSolanaTrigger(), makeSolanaAttestation(), [
        { message: buildNativeMessage() },
        { message: buildNativeMessage() },
      ]),
    ).toThrow(/solana deposit requires exactly 1 transaction/);
  });

  it("rejects a message containing more than one instruction", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeSolanaTrigger(), makeSolanaAttestation(), [
        {
          message: buildNativeMessage({
            extraInstructions: [
              { programIdIndex: 4, accountIndexes: [0], data: new Uint8Array([0x01]) },
            ],
          }),
        },
      ]),
    ).toThrow(/must contain exactly 1 instruction, got 2/);
  });

  it("rejects an instruction whose program does not match attestation.inputDepository", () => {
    const otherProgram = new Uint8Array(32).fill(0xee);
    expect(() =>
      verifyTransactionsWithWallet(makeSolanaTrigger(), makeSolanaAttestation(), [
        {
          message: buildNativeMessage({
            staticAccountKeys: [
              signerKey,
              depositorKey,
              relayDepositoryPdaKey,
              vaultKey,
              systemProgramKey,
              otherProgram,
            ],
          }),
        },
      ]),
    ).toThrow(/instruction program mismatch/);
  });

  it("rejects an instruction with the wrong discriminator", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeSolanaTrigger(), makeSolanaAttestation(), [
        {
          message: buildNativeMessage({ discriminator: new Uint8Array(8).fill(0xff) }),
        },
      ]),
    ).toThrow(/instruction discriminator does not match deposit_native/);
  });

  it("rejects an instruction whose data is not 48 bytes", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeSolanaTrigger(), makeSolanaAttestation(), [
        { message: buildNativeMessage({ data: DEPOSIT_NATIVE_DISCRIMINATOR_BYTES }) },
      ]),
    ).toThrow(/deposit_native: instruction data must be 48 bytes/);
  });

  it("rejects an instruction with the wrong number of accounts", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeSolanaTrigger(), makeSolanaAttestation(), [
        // 4 accounts instead of 5
        { message: buildNativeMessage({ accountIndexes: [2, 0, 1, 3] }) },
      ]),
    ).toThrow(/deposit_native must reference exactly 5 accounts/);
  });

  it("rejects an instruction whose depositor doesn't match derivationFields.depositor", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeSolanaTrigger(), makeSolanaAttestation(), [
        // accounts[2] (depositor in Anchor order) points to signerKey, not depositorKey
        { message: buildNativeMessage({ accountIndexes: [2, 0, 0, 3, 4] }) },
      ]),
    ).toThrow(/deposit_native\.depositor mismatch/);
  });

  it("rejects an instruction whose amount doesn't match input.amount", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeSolanaTrigger(), makeSolanaAttestation(), [
        { message: buildNativeMessage({ amount: SOLANA_INPUT_AMOUNT - 1n }) },
      ]),
    ).toThrow(/deposit_native\.amount mismatch/);
  });

  it("rejects an instruction whose id doesn't match trigger.orderId", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeSolanaTrigger(), makeSolanaAttestation(), [
        { message: buildNativeMessage({ orderId: `0x${"99".repeat(32)}` }) },
      ]),
    ).toThrow(/deposit_native\.id mismatch/);
  });

  it("rejects an instruction whose depositor slot references an out-of-range account (ATL)", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeSolanaTrigger(), makeSolanaAttestation(), [
        // accounts[2] (depositor) -> index 99, which doesn't exist in staticAccountKeys
        { message: buildNativeMessage({ accountIndexes: [2, 0, 99, 3, 4] }) },
      ]),
    ).toThrow(/address-table-lookups are not supported/);
  });

  it("rejects a versioned v1+ message", () => {
    // Start the message with marker byte 0x81 (= 0x80 | version 1).
    const legacy = Buffer.from(buildNativeMessage(), "base64");
    const v1 = Buffer.concat([Buffer.from([0x81]), legacy]).toString("base64");
    expect(() =>
      verifyTransactionsWithWallet(makeSolanaTrigger(), makeSolanaAttestation(), [{ message: v1 }]),
    ).toThrow(/unsupported solana message version v1/);
  });

  // ── fee-payer variants ───────────────────────────────────────────────────
  //
  // 2-signer layout (deposit wallet at slot 1, separate fee payer at slot 0):
  //   0: feePayerKey
  //   1: depositWalletKey  (= the Anchor "sender")
  //   2: depositorKey
  //   3: relayDepositoryPdaKey
  //   4: vaultKey
  //   5: systemProgramKey
  //   6: programKey
  // Instruction account-indexes follow Anchor order
  // [relay_depository=3, sender=1, depositor=2, vault=4, system_program=5].
  const feePayerKey = new Uint8Array(32).fill(0x11);
  const feePayerStaticKeys = [
    feePayerKey, // 0: fee payer (signer slot 0)
    signerKey, // 1: deposit wallet (signer slot 1)
    depositorKey, // 2: depositor
    relayDepositoryPdaKey, // 3: relay_depository pda
    vaultKey, // 4: vault
    systemProgramKey, // 5: system program
    programKey, // 6: relay-depository program
  ];

  it("accepts a 2-signer deposit_native with a separate fee payer", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeSolanaTrigger(), makeSolanaAttestation(), [
        {
          message: buildNativeMessage({
            numRequiredSignatures: 2,
            staticAccountKeys: feePayerStaticKeys,
            programIdIndex: 6,
            accountIndexes: [3, 1, 2, 4, 5],
          }),
        },
      ]),
    ).not.toThrow();
  });

  it("rejects a 2-signer message where the sender slot isn't slot 1", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeSolanaTrigger(), makeSolanaAttestation(), [
        {
          message: buildNativeMessage({
            numRequiredSignatures: 2,
            staticAccountKeys: feePayerStaticKeys,
            programIdIndex: 6,
            // sender now points to slot 0 (the fee payer) instead of slot 1
            accountIndexes: [3, 0, 2, 4, 5],
          }),
        },
      ]),
    ).toThrow(/instruction sender slot must be 1 \(the deposit wallet\), got 0/);
  });

  it("rejects a 1-signer message where the sender slot isn't slot 0", () => {
    // Default 1-signer layout, but accountIndexes[1] points to depositorKey
    // (slot 1) instead of signerKey (slot 0).
    expect(() =>
      verifyTransactionsWithWallet(makeSolanaTrigger(), makeSolanaAttestation(), [
        { message: buildNativeMessage({ accountIndexes: [2, 1, 1, 3, 4] }) },
      ]),
    ).toThrow(/instruction sender slot must be 0 \(the deposit wallet\), got 1/);
  });

  it("rejects a message with 3 required signatures", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeSolanaTrigger(), makeSolanaAttestation(), [
        {
          message: buildNativeMessage({
            numRequiredSignatures: 3,
            staticAccountKeys: [
              feePayerKey, // 0
              new Uint8Array(32).fill(0x22), // 1: extra signer
              signerKey, // 2: wallet
              depositorKey, // 3
              relayDepositoryPdaKey, // 4
              vaultKey, // 5
              systemProgramKey, // 6
              programKey, // 7
            ],
            programIdIndex: 7,
            accountIndexes: [4, 2, 3, 5, 6],
          }),
        },
      ]),
    ).toThrow(/numRequiredSignatures must be 1 or 2 \(got 3\)/);
  });
});

describe("solana-vm transaction policy (deposit_token)", () => {
  const signerKey = new Uint8Array(32).fill(0x42);
  const programKey = hexToBytes32(SOLANA_DEPOSITORY_HEX);
  const depositorKey = hexToBytes32(SOLANA_DEPOSITOR_HEX);
  const mintKey = hexToBytes32(SOLANA_MINT_HEX);
  const systemProgramKey = new Uint8Array(32);
  const vaultKey = new Uint8Array(32).fill(0x99);
  const relayDepositoryPdaKey = new Uint8Array(32).fill(0x55);
  const senderTokenAccount = new Uint8Array(32).fill(0x66);
  const vaultTokenAccount = new Uint8Array(32).fill(0x77);
  const tokenProgram = new Uint8Array(32).fill(0x88);
  const associatedTokenProgram = new Uint8Array(32).fill(0xaa);

  function buildTokenMessage(
    args: {
      amount?: bigint;
      orderId?: `0x${string}`;
      discriminator?: Uint8Array;
      accountIndexes?: number[];
      programIdIndex?: number;
      staticAccountKeys?: Uint8Array[];
      numRequiredSignatures?: number;
    } = {},
  ): string {
    const staticAccountKeys = args.staticAccountKeys ?? [
      signerKey,
      depositorKey,
      relayDepositoryPdaKey,
      vaultKey,
      mintKey,
      senderTokenAccount,
      vaultTokenAccount,
      tokenProgram,
      associatedTokenProgram,
      systemProgramKey,
      programKey,
    ];
    return buildLegacyMessage({
      numRequiredSignatures: args.numRequiredSignatures,
      staticAccountKeys,
      instructions: [
        {
          programIdIndex: args.programIdIndex ?? 10,
          accountIndexes: args.accountIndexes ?? [2, 0, 1, 3, 4, 5, 6, 7, 8, 9],
          data: buildDepositArgs(
            args.discriminator ?? DEPOSIT_TOKEN_DISCRIMINATOR_BYTES,
            args.amount ?? SOLANA_INPUT_AMOUNT,
            args.orderId ?? SOLANA_ORDER_ID,
          ),
        },
      ],
    });
  }

  const erc20LikeTrigger = () => makeSolanaTrigger({ inputCurrency: SOLANA_MINT_HEX });

  it("accepts a well-formed deposit_token instruction", () => {
    expect(() =>
      verifyTransactionsWithWallet(erc20LikeTrigger(), makeSolanaAttestation(), [
        { message: buildTokenMessage() },
      ]),
    ).not.toThrow();
  });

  it("rejects an instruction with the wrong discriminator", () => {
    expect(() =>
      verifyTransactionsWithWallet(erc20LikeTrigger(), makeSolanaAttestation(), [
        { message: buildTokenMessage({ discriminator: DEPOSIT_NATIVE_DISCRIMINATOR_BYTES }) },
      ]),
    ).toThrow(/instruction discriminator does not match deposit_token/);
  });

  it("rejects an instruction with the wrong number of accounts", () => {
    expect(() =>
      verifyTransactionsWithWallet(erc20LikeTrigger(), makeSolanaAttestation(), [
        // 9 accounts instead of 10
        { message: buildTokenMessage({ accountIndexes: [2, 0, 1, 3, 4, 5, 6, 7, 8] }) },
      ]),
    ).toThrow(/deposit_token must reference exactly 10 accounts/);
  });

  it("rejects an instruction whose mint doesn't match input.currency", () => {
    expect(() =>
      verifyTransactionsWithWallet(erc20LikeTrigger(), makeSolanaAttestation(), [
        // accounts[4] (mint) points to signer (index 0) instead of mintKey (index 4)
        { message: buildTokenMessage({ accountIndexes: [2, 0, 1, 3, 0, 5, 6, 7, 8, 9] }) },
      ]),
    ).toThrow(/deposit_token\.mint mismatch/);
  });

  it("rejects an instruction whose depositor doesn't match derivationFields.depositor", () => {
    expect(() =>
      verifyTransactionsWithWallet(erc20LikeTrigger(), makeSolanaAttestation(), [
        // accounts[2] (depositor) -> static index 4 (mintKey) instead of 1 (depositorKey)
        { message: buildTokenMessage({ accountIndexes: [2, 0, 4, 3, 4, 5, 6, 7, 8, 9] }) },
      ]),
    ).toThrow(/deposit_token\.depositor mismatch/);
  });

  it("rejects an instruction whose amount doesn't match input.amount", () => {
    expect(() =>
      verifyTransactionsWithWallet(erc20LikeTrigger(), makeSolanaAttestation(), [
        { message: buildTokenMessage({ amount: SOLANA_INPUT_AMOUNT + 1n }) },
      ]),
    ).toThrow(/deposit_token\.amount mismatch/);
  });

  it("rejects an instruction whose id doesn't match trigger.orderId", () => {
    expect(() =>
      verifyTransactionsWithWallet(erc20LikeTrigger(), makeSolanaAttestation(), [
        { message: buildTokenMessage({ orderId: `0x${"77".repeat(32)}` }) },
      ]),
    ).toThrow(/deposit_token\.id mismatch/);
  });

  it("accepts a 2-signer deposit_token with a separate fee payer", () => {
    // 2-signer layout (deposit wallet at slot 1, fee payer at slot 0):
    //   0: feePayerKey
    //   1: signerKey               (= deposit wallet)
    //   2: depositorKey
    //   3: relayDepositoryPdaKey
    //   4: vaultKey
    //   5: mintKey
    //   6: senderTokenAccount
    //   7: vaultTokenAccount
    //   8: tokenProgram
    //   9: associatedTokenProgram
    //  10: systemProgramKey
    //  11: programKey
    const feePayerKey = new Uint8Array(32).fill(0x11);
    expect(() =>
      verifyTransactionsWithWallet(erc20LikeTrigger(), makeSolanaAttestation(), [
        {
          message: buildTokenMessage({
            numRequiredSignatures: 2,
            staticAccountKeys: [
              feePayerKey,
              signerKey,
              depositorKey,
              relayDepositoryPdaKey,
              vaultKey,
              mintKey,
              senderTokenAccount,
              vaultTokenAccount,
              tokenProgram,
              associatedTokenProgram,
              systemProgramKey,
              programKey,
            ],
            programIdIndex: 11,
            // Anchor order: [relay_depository=3, sender=1, depositor=2,
            // vault=4, mint=5, sender_ta=6, vault_ta=7, token_program=8,
            // ata_program=9, system_program=10].
            accountIndexes: [3, 1, 2, 4, 5, 6, 7, 8, 9, 10],
          }),
        },
      ]),
    ).not.toThrow();
  });
});
