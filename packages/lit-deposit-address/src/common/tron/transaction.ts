import { sha256 } from "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/sha2.js/+esm";
import { utils } from "https://cdn.jsdelivr.net/npm/tronweb@6.1.0/+esm";
import { bytesToHex, hexToBytes } from "../bytes.js";

const TRIGGER_SMART_CONTRACT_TYPE_URL = "type.googleapis.com/protocol.TriggerSmartContract";

/** Decoded Tron TriggerSmartContract payload authorized by this action. */
export interface ParsedTronTriggerSmartContract {
  type: "TriggerSmartContract";
  ownerAddress: string;
  contractAddress: string;
  callValue: bigint;
  data: string;
}

/** Decoded fields that make up the canonical Tron transaction id. */
export interface ParsedTronRawData {
  refBlockBytes: string;
  refBlockHash: string;
  expiration: bigint;
  timestamp: bigint;
  feeLimit: bigint;
  contract: ParsedTronTriggerSmartContract;
}

/** Strictly decoded canonical Tron protocol.Transaction.raw bytes. */
export interface ParsedTronTransaction {
  rawData: ParsedTronRawData;
  rawDataBytes: Uint8Array;
}

/** JSON shape consumed and returned by TronWeb's transaction utilities. */
interface TronWebRawData {
  contract: [TronWebContract];
  data: string;
  fee_limit: number;
  ref_block_bytes: string;
  ref_block_hash: string;
  expiration: number;
  timestamp: number;
  scripts: string;
  auths: [];
}

/** TronWeb JSON representation of one TriggerSmartContract. */
interface TronWebContract {
  parameter: {
    value: TronWebTriggerSmartContract;
    type_url: string;
  };
  type: "TriggerSmartContract";
  Permission_id: 0;
}

/** TronWeb JSON representation of the TriggerSmartContract payload. */
interface TronWebTriggerSmartContract {
  owner_address: string;
  contract_address: string;
  call_value: number;
  data: string;
  call_token_value: 0;
  token_id: 0;
}

/** Minimal public surface of TronWeb's generated protocol.Transaction object. */
interface TronWebProtobufTransaction {
  getRawData(): { serializeBinary(): Uint8Array };
  addSignature(signature: Uint8Array): void;
  serializeBinary(): Uint8Array;
}

/** Return a record or reject an unexpected TronWeb result. */
function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Return a string field from a decoded TronWeb object. */
function stringField(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  return value;
}

/** Return a non-negative safe integer from a decoded TronWeb object. */
function integerField(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

/** Normalize and validate an even-length hexadecimal field. */
function hexField(value: unknown, field: string): string {
  const normalized = stringField(value, field).toLowerCase();
  if (!/^(?:[0-9a-f]{2})*$/u.test(normalized)) {
    throw new Error(`${field} must be even-length hex`);
  }
  return normalized;
}

/** Normalize and validate a hex string with an exact byte length. */
function fixedHex(value: unknown, field: string, byteLength: number): string {
  const normalized = hexField(value, field);
  if (normalized.length !== byteLength * 2) {
    throw new Error(`${field} must be ${byteLength} bytes`);
  }
  return normalized;
}

/** Validate TronWeb's untyped TriggerSmartContract JSON result. */
function tronWebRawData(value: unknown): TronWebRawData {
  const rawData = record(value, "Tron raw_data");
  if (!Array.isArray(rawData.contract) || rawData.contract.length !== 1) {
    throw new Error("Tron raw_data must contain exactly one contract");
  }
  const contract = record(rawData.contract[0], "Tron contract");
  if (contract.type !== "TriggerSmartContract") {
    throw new Error("Tron contract must be TriggerSmartContract");
  }
  if (integerField(contract.Permission_id, "Tron contract Permission_id") !== 0) {
    throw new Error("Tron contract Permission_id must be zero");
  }
  const parameter = record(contract.parameter, "Tron contract parameter");
  const typeUrl = stringField(parameter.type_url, "Tron contract type_url");
  if (typeUrl !== TRIGGER_SMART_CONTRACT_TYPE_URL) {
    throw new Error("Tron contract type_url must identify TriggerSmartContract");
  }
  const trigger = record(parameter.value, "Tron TriggerSmartContract");
  const callTokenValue = integerField(
    trigger.call_token_value,
    "Tron TriggerSmartContract call_token_value",
  );
  const tokenId = integerField(trigger.token_id, "Tron TriggerSmartContract token_id");
  if (callTokenValue !== 0 || tokenId !== 0) {
    throw new Error("Tron TriggerSmartContract token fields must be zero");
  }
  const memo = stringField(rawData.data, "Tron raw_data data");
  const scripts = stringField(rawData.scripts, "Tron raw_data scripts");
  if (memo !== "" || scripts !== "") {
    throw new Error("Tron raw_data memo and scripts must be empty");
  }
  if (!Array.isArray(rawData.auths) || rawData.auths.length !== 0) {
    throw new Error("Tron raw_data auths must be empty");
  }
  const timestamp = integerField(rawData.timestamp, "Tron raw_data timestamp");
  const expiration = integerField(rawData.expiration, "Tron raw_data expiration");
  if (timestamp === 0 || expiration === 0) {
    throw new Error("Tron raw_data timestamp and expiration are required");
  }

  return {
    contract: [
      {
        parameter: {
          value: {
            owner_address: fixedHex(
              trigger.owner_address,
              "Tron TriggerSmartContract owner_address",
              21,
            ),
            contract_address: fixedHex(
              trigger.contract_address,
              "Tron TriggerSmartContract contract_address",
              21,
            ),
            call_value: integerField(trigger.call_value, "Tron TriggerSmartContract call_value"),
            data: hexField(trigger.data, "Tron TriggerSmartContract data"),
            call_token_value: 0,
            token_id: 0,
          },
          type_url: TRIGGER_SMART_CONTRACT_TYPE_URL,
        },
        type: "TriggerSmartContract",
        Permission_id: 0,
      },
    ],
    data: "",
    fee_limit: integerField(rawData.fee_limit, "Tron raw_data fee_limit"),
    ref_block_bytes: fixedHex(rawData.ref_block_bytes, "Tron raw_data ref_block_bytes", 2),
    ref_block_hash: fixedHex(rawData.ref_block_hash, "Tron raw_data ref_block_hash", 8),
    expiration,
    timestamp,
    scripts: "",
    auths: [],
  };
}

/** Validate the generated protobuf object returned by TronWeb. */
function protobufTransaction(value: unknown): TronWebProtobufTransaction {
  const transaction = record(value, "TronWeb protobuf transaction");
  if (
    typeof transaction.getRawData !== "function" ||
    typeof transaction.addSignature !== "function" ||
    typeof transaction.serializeBinary !== "function"
  ) {
    throw new Error("TronWeb returned an invalid protobuf transaction");
  }
  return value as TronWebProtobufTransaction;
}

/** Build a generated TronWeb protobuf transaction from validated JSON. */
function encodeWithTronWeb(rawData: TronWebRawData): TronWebProtobufTransaction {
  const encoded: unknown = utils.transaction.txJsonToPb({
    visible: false,
    txID: "",
    raw_data_hex: "",
    raw_data: rawData,
  });
  return protobufTransaction(encoded);
}

/** Compare two byte arrays without changing either input. */
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Decode and validate canonical Tron protocol.Transaction.raw protobuf bytes. */
export function decodeTronRawData(encoded: string): ParsedTronTransaction {
  const rawDataBytes = hexToBytes(encoded, "Tron raw_data");
  let decoded: unknown;
  try {
    decoded = utils.deserializeTx.deserializeTransaction(
      "TriggerSmartContract",
      bytesToHex(rawDataBytes),
    );
  } catch (error) {
    throw new Error(`invalid Tron raw_data: ${String(error)}`, { cause: error });
  }
  const decodedRawData = tronWebRawData(decoded);
  const reencoded = encodeWithTronWeb(decodedRawData).getRawData().serializeBinary();
  if (!equalBytes(rawDataBytes, reencoded)) {
    throw new Error("Tron raw_data is not canonical");
  }
  const contract = decodedRawData.contract[0].parameter.value;
  return {
    rawData: {
      refBlockBytes: decodedRawData.ref_block_bytes,
      refBlockHash: decodedRawData.ref_block_hash,
      expiration: BigInt(decodedRawData.expiration),
      timestamp: BigInt(decodedRawData.timestamp),
      feeLimit: BigInt(decodedRawData.fee_limit),
      contract: {
        type: "TriggerSmartContract",
        ownerAddress: contract.owner_address,
        contractAddress: contract.contract_address,
        callValue: BigInt(contract.call_value),
        data: contract.data,
      },
    },
    rawDataBytes,
  };
}

/** Convert a parsed transaction back to the validated TronWeb JSON shape. */
function parsedRawData(rawData: ParsedTronRawData): TronWebRawData {
  return {
    contract: [
      {
        parameter: {
          value: {
            owner_address: rawData.contract.ownerAddress,
            contract_address: rawData.contract.contractAddress,
            call_value: Number(rawData.contract.callValue),
            data: rawData.contract.data,
            call_token_value: 0,
            token_id: 0,
          },
          type_url: TRIGGER_SMART_CONTRACT_TYPE_URL,
        },
        type: "TriggerSmartContract",
        Permission_id: 0,
      },
    ],
    data: "",
    fee_limit: Number(rawData.feeLimit),
    ref_block_bytes: rawData.refBlockBytes,
    ref_block_hash: rawData.refBlockHash,
    expiration: Number(rawData.expiration),
    timestamp: Number(rawData.timestamp),
    scripts: "",
    auths: [],
  };
}

/** Compute the canonical lowercase transaction id from exact raw_data bytes. */
export function tronTransactionHash(encodedRawData: string): string {
  return bytesToHex(sha256(decodeTronRawData(encodedRawData).rawDataBytes));
}

/** Build a signed protocol.Transaction using TronWeb's generated encoder. */
export function encodeSignedTronTransaction(
  parsed: ParsedTronTransaction,
  signature: Uint8Array,
): string {
  if (signature.length !== 65) {
    throw new Error("Tron signature must be 65 bytes");
  }
  const transaction = encodeWithTronWeb(parsedRawData(parsed.rawData));
  const reencoded = transaction.getRawData().serializeBinary();
  if (!equalBytes(parsed.rawDataBytes, reencoded)) {
    throw new Error("Tron raw_data changed before signing");
  }
  transaction.addSignature(signature);
  return `0x${bytesToHex(transaction.serializeBinary())}`;
}
