import { ComputeBudgetProgram } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { verifyTransactionsWithWallet } from "../../src/derivation/index.js";
import {
  COMPUTE_BUDGET_PROGRAM_KEY,
  DEPOSIT_NATIVE_DISCRIMINATOR_BYTES,
  SOLANA_DEPOSITORY_HEX,
  SOLANA_DEPOSITOR_HEX,
  SOLANA_INPUT_AMOUNT,
  SOLANA_ORDER_ID,
  buildDepositArgs,
  buildLegacyMessage,
  computeUnitLimitIx,
  computeUnitPriceIx,
  hexToBytes32,
  makeSolanaAttestation,
  makeSolanaTrigger,
  type SolanaMessageInputs,
} from "./solana-shared.js";

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
      prefixInstructions?: SolanaMessageInputs["instructions"];
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
      // With prefix instructions, the ComputeBudget program is appended as the last static key.
      staticAccountKeys: args.prefixInstructions
        ? [...staticAccountKeys, COMPUTE_BUDGET_PROGRAM_KEY]
        : staticAccountKeys,
      instructions: [
        ...(args.prefixInstructions ?? []),
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

  it("rejects an instruction after the deposit", () => {
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
    ).toThrow(/instructions\[0\] must be a ComputeBudget instruction \(the deposit must be last\)/);
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

  // ── ComputeBudget prefix (priority fee) ──────────────────────────────────
  const COMPUTE_BUDGET_INDEX = 6;
  const verifyWithPrefix = (prefixInstructions: SolanaMessageInputs["instructions"]) =>
    verifyTransactionsWithWallet(makeSolanaTrigger(), makeSolanaAttestation(), [
      { message: buildNativeMessage({ prefixInstructions }) },
    ]);

  it("encodes ComputeBudget helpers byte-for-byte like @solana/web3.js", () => {
    expect(Buffer.from(ComputeBudgetProgram.programId.toBytes())).toEqual(
      Buffer.from(COMPUTE_BUDGET_PROGRAM_KEY),
    );
    expect(Buffer.from(computeUnitLimitIx(200_000, COMPUTE_BUDGET_INDEX).data)).toEqual(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }).data,
    );
    expect(Buffer.from(computeUnitPriceIx(1_000_000n, COMPUTE_BUDGET_INDEX).data)).toEqual(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }).data,
    );
  });

  it("accepts SetComputeUnitLimit + SetComputeUnitPrice before the deposit", () => {
    expect(() =>
      verifyWithPrefix([
        computeUnitLimitIx(150_000, COMPUTE_BUDGET_INDEX),
        computeUnitPriceIx(50_000n, COMPUTE_BUDGET_INDEX),
      ]),
    ).not.toThrow();
  });

  it("accepts SetComputeUnitPrice before SetComputeUnitLimit", () => {
    expect(() =>
      verifyWithPrefix([
        computeUnitPriceIx(50_000n, COMPUTE_BUDGET_INDEX),
        computeUnitLimitIx(150_000, COMPUTE_BUDGET_INDEX),
      ]),
    ).not.toThrow();
  });

  it("accepts SetComputeUnitLimit alone", () => {
    expect(() =>
      verifyWithPrefix([computeUnitLimitIx(150_000, COMPUTE_BUDGET_INDEX)]),
    ).not.toThrow();
  });

  it("accepts SetComputeUnitPrice alone", () => {
    expect(() =>
      verifyWithPrefix([computeUnitPriceIx(1_000_000n, COMPUTE_BUDGET_INDEX)]),
    ).not.toThrow();
  });

  it("accepts the exact caps (200,000 CU and 1,000,000 micro-lamports)", () => {
    expect(() =>
      verifyWithPrefix([
        computeUnitLimitIx(200_000, COMPUTE_BUDGET_INDEX),
        computeUnitPriceIx(1_000_000n, COMPUTE_BUDGET_INDEX),
      ]),
    ).not.toThrow();
  });

  it("accepts ComputeBudget instructions in the 2-signer fee payer layout", () => {
    expect(() =>
      verifyTransactionsWithWallet(makeSolanaTrigger(), makeSolanaAttestation(), [
        {
          message: buildNativeMessage({
            numRequiredSignatures: 2,
            staticAccountKeys: feePayerStaticKeys,
            programIdIndex: 6,
            accountIndexes: [3, 1, 2, 4, 5],
            prefixInstructions: [
              computeUnitLimitIx(200_000, feePayerStaticKeys.length),
              computeUnitPriceIx(1_000_000n, feePayerStaticKeys.length),
            ],
          }),
        },
      ]),
    ).not.toThrow();
  });

  it("rejects a compute unit limit above 200,000", () => {
    expect(() => verifyWithPrefix([computeUnitLimitIx(200_001, COMPUTE_BUDGET_INDEX)])).toThrow(
      /SetComputeUnitLimit must not exceed 200000 \(got 200001\)/,
    );
  });

  it("rejects a compute unit price above 1,000,000 micro-lamports", () => {
    expect(() =>
      verifyWithPrefix([
        computeUnitLimitIx(200_000, COMPUTE_BUDGET_INDEX),
        computeUnitPriceIx(1_000_001n, COMPUTE_BUDGET_INDEX),
      ]),
    ).toThrow(/SetComputeUnitPrice must not exceed 1000000 micro-lamports \(got 1000001\)/);
  });

  it("rejects a duplicate SetComputeUnitLimit", () => {
    expect(() =>
      verifyWithPrefix([
        computeUnitLimitIx(1, COMPUTE_BUDGET_INDEX),
        computeUnitLimitIx(1, COMPUTE_BUDGET_INDEX),
      ]),
    ).toThrow(/duplicate SetComputeUnitLimit instruction/);
  });

  it("rejects RequestHeapFrame (tag 1)", () => {
    expect(() =>
      verifyWithPrefix([
        {
          programIdIndex: COMPUTE_BUDGET_INDEX,
          accountIndexes: [],
          data: new Uint8Array([1, 0, 0, 1, 0]),
        },
      ]),
    ).toThrow(/unsupported ComputeBudget instruction tag 1/);
  });

  it("rejects SetLoadedAccountsDataSizeLimit (tag 4)", () => {
    expect(() =>
      verifyWithPrefix([
        {
          programIdIndex: COMPUTE_BUDGET_INDEX,
          accountIndexes: [],
          data: new Uint8Array([4, 0, 0, 1, 0]),
        },
      ]),
    ).toThrow(/unsupported ComputeBudget instruction tag 4/);
  });

  it("rejects a ComputeBudget instruction that references accounts", () => {
    expect(() =>
      verifyWithPrefix([{ ...computeUnitLimitIx(1, COMPUTE_BUDGET_INDEX), accountIndexes: [0] }]),
    ).toThrow(/ComputeBudget instruction must not reference accounts/);
  });

  it("rejects a ComputeBudget instruction with the wrong data length", () => {
    const ix = computeUnitLimitIx(1, COMPUTE_BUDGET_INDEX);
    expect(() => verifyWithPrefix([{ ...ix, data: new Uint8Array([...ix.data, 0]) }])).toThrow(
      /SetComputeUnitLimit data must be 5 bytes, got 6/,
    );
  });

  it("rejects a duplicate SetComputeUnitPrice", () => {
    expect(() =>
      verifyWithPrefix([
        computeUnitLimitIx(1, COMPUTE_BUDGET_INDEX),
        computeUnitPriceIx(1n, COMPUTE_BUDGET_INDEX),
        computeUnitPriceIx(1n, COMPUTE_BUDGET_INDEX),
      ]),
    ).toThrow(/duplicate SetComputeUnitPrice instruction/);
  });

  it("rejects a non-ComputeBudget instruction before the deposit", () => {
    // System program (static key 4).
    expect(() =>
      verifyWithPrefix([{ programIdIndex: 4, accountIndexes: [], data: new Uint8Array([2]) }]),
    ).toThrow(/instructions\[0\] must be a ComputeBudget instruction/);
  });
});
