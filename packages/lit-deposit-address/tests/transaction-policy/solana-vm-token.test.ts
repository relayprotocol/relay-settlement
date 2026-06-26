import { describe, expect, it } from "vitest";
import { verifyTransactionsWithWallet } from "../../src/derivation/index.js";
import {
  DEPOSIT_NATIVE_DISCRIMINATOR_BYTES,
  DEPOSIT_TOKEN_DISCRIMINATOR_BYTES,
  SOLANA_DEPOSITORY_HEX,
  SOLANA_DEPOSITOR_HEX,
  SOLANA_INPUT_AMOUNT,
  SOLANA_MINT_HEX,
  SOLANA_ORDER_ID,
  buildDepositArgs,
  buildLegacyMessage,
  hexToBytes32,
  makeSolanaAttestation,
  makeSolanaTrigger,
} from "./solana-shared.js";

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
