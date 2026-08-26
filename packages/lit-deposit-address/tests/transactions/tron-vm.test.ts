import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utils } from "tronweb";
import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes } from "../../src/common/bytes.js";
import { decodeTronRawData, tronTransactionHash } from "../../src/common/tron/transaction.js";
import { deriveWallet, signTransactionsWithWallet } from "../../src/derivation/index.js";
import { PATH, ROOT_KEY } from "./shared.js";
import {
  buildTriggerContractTransaction,
  buildTransferTransaction,
  OTHER_TRON_ADDRESS,
  tronAddressWord,
  TRON_TOKEN,
} from "./tron-helpers.js";

const REFERENCE_TRIGGER_RAW_DATA =
  "0x0a02abcd2208001122334455667740e0a499ffbc315ab101081f12ac010a31747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e54726967676572536d617274436f6e747261637412770a15417e5f4552091a69125d5dfcb7b8c2659029395bdf121541f0623e1012177482912fb057e44e1a9769b1f58818e807224449290c1c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000007080d095ffbc31900180c2d72f";
const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

describe("tron-vm protobuf transactions", () => {
  it("encodes TVM ABI address words like TronWeb", () => {
    expect(`0x${tronAddressWord(TRON_TOKEN)}`).toBe(
      utils.abi.encodeParams(["address"], [TRON_TOKEN]),
    );
  });

  it("decodes a TronWeb reference TriggerSmartContract fixture", () => {
    const parsed = decodeTronRawData(REFERENCE_TRIGGER_RAW_DATA);

    expect(parsed.rawData.refBlockBytes).toBe("abcd");
    expect(parsed.rawData.refBlockHash).toBe("0011223344556677");
    expect(parsed.rawData.timestamp).toBe(1_700_000_000_000n);
    expect(parsed.rawData.expiration).toBe(1_700_000_060_000n);
    expect(parsed.rawData.contract).toMatchObject({
      type: "TriggerSmartContract",
      ownerAddress: "417e5f4552091a69125d5dfcb7b8c2659029395bdf",
      contractAddress: "41f0623e1012177482912fb057e44e1a9769b1f588",
      callValue: 1_000n,
    });
  });

  it("computes the same transaction id as TronWeb", () => {
    expect(tronTransactionHash(REFERENCE_TRIGGER_RAW_DATA)).toBe(
      "fb0b414d1cfd6a8cee09d96efc2a53f1349fb3c9cac49cb34fc14d8cd31a21e0",
    );
  });

  it("rejects an unknown protobuf field", () => {
    expect(() => decodeTronRawData(`${REFERENCE_TRIGGER_RAW_DATA}980101`)).toThrow(
      "Tron raw_data is not canonical",
    );
  });

  it("rejects a duplicate singular protobuf field", () => {
    const duplicateTimestamp = `${REFERENCE_TRIGGER_RAW_DATA}7080d095ffbc31`;

    expect(() => decodeTronRawData(duplicateTimestamp)).toThrow();
  });

  it("rejects out-of-order protobuf fields", () => {
    const refBlockBytes = REFERENCE_TRIGGER_RAW_DATA.slice(2, 10);
    const reordered = `0x${REFERENCE_TRIGGER_RAW_DATA.slice(10)}${refBlockBytes}`;

    expect(() => decodeTronRawData(reordered)).toThrow();
  });

  it("rejects a non-minimal protobuf varint", () => {
    const nonMinimalExpiration = REFERENCE_TRIGGER_RAW_DATA.replace(
      "40e0a499ffbc31",
      "40e0a499ffbcb100",
    );

    expect(() => decodeTronRawData(nonMinimalExpiration)).toThrow();
  });

  it("rejects an unsupported raw_data memo", () => {
    expect(() => decodeTronRawData(`${REFERENCE_TRIGGER_RAW_DATA}5201ff`)).toThrow(
      "Tron raw_data memo and scripts must be empty",
    );
  });

  it("rejects multiple contracts", async () => {
    const wallet = await deriveWallet(ROOT_KEY, "tron-vm", PATH);
    const transaction = buildTriggerContractTransaction({
      purpose: "native-deposit",
      owner: wallet.address,
      contractAddress: TRON_TOKEN,
      data: "00",
      duplicateContract: true,
    });

    expect(() => decodeTronRawData(transaction.rawData)).toThrow("Tron raw_data is not canonical");
  });

  it("rejects a mismatched TriggerSmartContract type URL", async () => {
    const wallet = await deriveWallet(ROOT_KEY, "tron-vm", PATH);
    const transaction = buildTriggerContractTransaction({
      purpose: "native-deposit",
      owner: wallet.address,
      contractAddress: TRON_TOKEN,
      data: "00",
      typeUrl: "type.googleapis.com/protocol.TransferContract",
    });

    expect(() => decodeTronRawData(transaction.rawData)).toThrow(
      "Tron contract type_url must identify TriggerSmartContract",
    );
  });

  it("rejects an unsupported contract under an accepted purpose", async () => {
    const wallet = await deriveWallet(ROOT_KEY, "tron-vm", PATH);
    const transfer = buildTransferTransaction({ owner: wallet.address });
    const transaction = { purpose: "native-deposit" as const, rawData: transfer.rawData };

    expect(() => decodeTronRawData(transaction.rawData)).toThrow("invalid Tron raw_data");
  });

  it("signs the raw_data hash in canonical Tron r || s || recovery format", async () => {
    const wallet = await deriveWallet(ROOT_KEY, "tron-vm", PATH);
    const transaction = buildTriggerContractTransaction({
      purpose: "native-deposit",
      owner: wallet.address,
      contractAddress: TRON_TOKEN,
      data: "00",
    });
    const { signedTransactions } = await signTransactionsWithWallet(ROOT_KEY, "tron-vm", PATH, [
      transaction,
    ]);
    const [signed] = signedTransactions;
    const signature = hexToBytes(signed.rawTransaction, "signed Tron transaction").slice(-65);
    const digest = sha256(hexToBytes(transaction.rawData, "Tron raw_data"));
    const parsed = decodeTronRawData(transaction.rawData);

    expect(signed.transactionHash).toBe(bytesToHex(digest));
    expect(signature).toHaveLength(65);
    expect(signature[64]).toBeLessThanOrEqual(1);
    expect(BigInt(`0x${bytesToHex(signature.slice(32, 64))}`)).toBeLessThanOrEqual(
      SECP256K1_ORDER / 2n,
    );
    expect(
      secp256k1.verify(signature.slice(0, 64), digest, hexToBytes(wallet.publicKey, "public key"), {
        prehash: false,
      }),
    ).toBe(true);
    expect(parsed.rawData.contract).toMatchObject({
      type: "TriggerSmartContract",
      contractAddress: bytesToHex(
        (await import("../../src/common/address/tron.js")).encodeTronAddress(TRON_TOKEN),
      ),
    });
  });

  it("refuses to sign a transaction owned by another Tron wallet", async () => {
    const transaction = buildTriggerContractTransaction({
      purpose: "native-deposit",
      owner: OTHER_TRON_ADDRESS,
      contractAddress: TRON_TOKEN,
      data: "00",
    });
    await expect(
      signTransactionsWithWallet(ROOT_KEY, "tron-vm", PATH, [transaction]),
    ).rejects.toThrow("Tron transaction owner mismatch");
  });

  it("refuses a batch when a later transaction is owned by another Tron wallet", async () => {
    const wallet = await deriveWallet(ROOT_KEY, "tron-vm", PATH);
    const ownedTransaction = buildTriggerContractTransaction({
      purpose: "native-deposit",
      owner: wallet.address,
      contractAddress: TRON_TOKEN,
      data: "00",
    });
    const otherTransaction = buildTriggerContractTransaction({
      purpose: "native-deposit",
      owner: OTHER_TRON_ADDRESS,
      contractAddress: TRON_TOKEN,
      data: "00",
    });

    await expect(
      signTransactionsWithWallet(ROOT_KEY, "tron-vm", PATH, [ownedTransaction, otherTransaction]),
    ).rejects.toThrow("Tron transaction owner mismatch");
  });
});
