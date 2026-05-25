import { secp256k1 } from "https://cdn.jsdelivr.net/npm/@noble/curves@2.0.1/secp256k1.js/+esm";
import { bytesToHex, hexToBytes } from "./bytes.js";
import { keccak256 } from "./crypto.js";

export interface Eip712Field {
  name: string;
  type: string;
}

export type Eip712Types = Record<string, Eip712Field[]>;

export interface Eip712Domain {
  name?: string;
  version?: string;
  chainId?: number | string | bigint;
  verifyingContract?: string;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function typeString(primaryType: string, types: Eip712Types): string {
  return `${primaryType}(${types[primaryType].map((f) => `${f.type} ${f.name}`).join(",")})`;
}

function uint256(value: number | string | bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = BigInt(value);
  for (let i = 31; i >= 0; i--, v >>= 8n) {
    out[i] = Number(v & 0xffn);
  }
  return out;
}

function address(value: string): Uint8Array {
  const raw = hexToBytes(value, "address");
  if (raw.length !== 20) {
    throw new Error("address must be 20 bytes");
  }
  const out = new Uint8Array(32);
  out.set(raw, 12);
  return out;
}

function bytes32(value: string): Uint8Array {
  const raw = hexToBytes(value, "bytes32");
  if (raw.length !== 32) {
    throw new Error("bytes32 must be 32 bytes");
  }
  return raw;
}

function value(type: string, v: unknown): Uint8Array {
  if (type === "string") {
    return keccak256(new TextEncoder().encode(String(v)));
  }
  if (type === "address") {
    return address(String(v));
  }
  if (type === "bytes32") {
    return bytes32(String(v));
  }
  if (type.startsWith("uint")) {
    return uint256(v as number | string | bigint);
  }
  throw new Error(`unsupported EIP-712 type: ${type}`);
}

function structHash(
  primaryType: string,
  data: Record<string, unknown>,
  types: Eip712Types,
): Uint8Array {
  return keccak256(
    concat([
      keccak256(new TextEncoder().encode(typeString(primaryType, types))),
      ...types[primaryType].map((field) => value(field.type, data[field.name])),
    ]),
  );
}

function domainTypes(domain: Eip712Domain): Eip712Types {
  const fields: Eip712Field[] = [];
  if (domain.name !== undefined) {
    fields.push({ name: "name", type: "string" });
  }
  if (domain.version !== undefined) {
    fields.push({ name: "version", type: "string" });
  }
  if (domain.chainId !== undefined) {
    fields.push({ name: "chainId", type: "uint256" });
  }
  if (domain.verifyingContract !== undefined) {
    fields.push({ name: "verifyingContract", type: "address" });
  }
  return { EIP712Domain: fields };
}

export function hashTypedData(args: {
  domain: Eip712Domain;
  types: Eip712Types;
  primaryType: string;
  message: Record<string, unknown>;
}): Uint8Array {
  return keccak256(
    concat([
      new Uint8Array([0x19, 0x01]),
      structHash("EIP712Domain", args.domain as Record<string, unknown>, domainTypes(args.domain)),
      structHash(args.primaryType, args.message, args.types),
    ]),
  );
}

export function signTypedDataHash(hash: Uint8Array, privateKey: Uint8Array): string {
  const sig = secp256k1.sign(hash, privateKey, { prehash: false, format: "recovered" });
  const out = new Uint8Array(65);
  out.set(sig.slice(1), 0);
  out[64] = sig[0] + 27;
  return `0x${bytesToHex(out)}`;
}
