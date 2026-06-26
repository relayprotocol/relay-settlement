/**
 * Lit Action: Lighter signer.
 *
 * Runs inside Lit's TEE. Lighter uses an EVM-style secp256k1 key for L1
 * signatures. Regular withdrawals sign oracle-attested hashes. The
 * `changePubKey` action signs a legacy EIP-155 transaction to the Lighter
 * gateway, but only for API keys compiled into the action's environment config.
 *
 * js_params:
 *   - pkpId:           string — PKP identifier
 *   - action:          string — "wallet" | "sign" | "changePubKey"
 *   - withdrawRequest: object — RelayAllocator WithdrawRequest (required for action=sign)
 *   - attestation:     object — oracle WithdrawRequestAttestation (required for action=sign)
 *   - changePubKey:    object — ChangePubKey transaction inputs (required for action=changePubKey)
 */
import { addr } from "https://cdn.jsdelivr.net/npm/micro-eth-signer@0.18.1/+esm";
import { sign as secpSign } from "https://cdn.jsdelivr.net/npm/micro-eth-signer@0.18.1/utils.js/+esm";
import {
  bytesToHex,
  deriveKey,
  hexToBytes,
  verifyWithdrawRequestAttestation,
  type WithdrawRequestAttestation,
  type WithdrawRequest,
} from "../common/index.js";
import { quantityToWord } from "../common/abi.js";
import { concatBytes, normalizeHex } from "../common/bytes.js";
import { keccak } from "../common/crypto.js";
import {
  ALLOCATOR_ADDRESS,
  ALLOWED_ORACLES,
  HUB_EVM_CHAIN_ID,
  ORACLE_SIGNATURE_THRESHOLD,
} from "../config.js";
import {
  LIGHTER_ALLOWED_API_KEYS,
  LIGHTER_GATEWAY,
  LIGHTER_GATEWAY_CHAIN_ID,
} from "../custom-configs/lighter-vm.js";

/** `js_params` passed by the Lit Action invoker. */
interface LighterActionParams {
  /** PKP identifier whose private key the action reconstructs inside the TEE. */
  pkpId: string;
  /** `"wallet"` to return only the derived address; `"sign"` for withdrawals; `"changePubKey"` for API-key setup. */
  action: "wallet" | "sign" | "changePubKey" | string;
  /** Original withdraw request fields. Required for `action="sign"`. */
  withdrawRequest?: WithdrawRequest;
  /** Oracle attestation containing the hashes to sign. Required for `action="sign"`. */
  attestation?: WithdrawRequestAttestation;
  /** Lighter ChangePubKey transaction inputs. Required for `action="changePubKey"`. */
  changePubKey?: LighterChangePubKeyInput;
}

/** Inputs needed to build and sign Lighter gateway `changePubKey`. */
interface LighterChangePubKeyInput {
  /** Lighter account index whose API key is being registered. */
  accountIndex: string | number | bigint;
  /** API key index to register. Must match an allowed configured key. */
  apiKeyIndex: string | number | bigint;
  /** API key public key as hex, with or without 0x prefix. Must be configured. */
  publicKey: string;
  /** Nonce for the derived L1 wallet on the gateway chain. */
  txNonce: string | number | bigint;
  /** Legacy transaction gas price. */
  gasPrice: string | number | bigint;
  /** Legacy transaction gas limit. */
  gasLimit: string | number | bigint;
}

/** Result returned for `action="wallet"`. */
interface LighterWalletResult {
  vmType: "lighter-vm";
  /** EIP-55-checksummed EVM address derived from the PKP. */
  address: string;
}

/** Result returned for `action="sign"`. Carries one signature per attested hash. */
interface LighterSignResult extends LighterWalletResult {
  /** keccak256(abi.encode(withdrawRequest)) as a 0x-prefixed hex string. */
  withdrawRequestHash: string;
  /** One entry per `attestation.hashesToSign`, in input order. */
  results: Array<{
    /** The signed digest as a 0x-prefixed hex string. */
    hash: string;
    /** secp256k1 signature in r+s+v form (v = 27 or 28), 65 bytes hex. */
    signature: string;
  }>;
}

/** Result returned for `action="changePubKey"`. */
interface LighterChangePubKeyResult extends LighterWalletResult {
  changePubKey: {
    /** Unsigned EIP-155 legacy transaction hash. */
    hash: string;
    /** ABI-encoded `changePubKey(uint48,uint8,bytes)` calldata. */
    data: string;
    /** RLP-encoded unsigned EIP-155 legacy transaction. */
    unsignedTransaction: string;
    /** RLP-encoded signed legacy transaction suitable for broadcast. */
    rawTransaction: string;
    /** secp256k1 signature in r+s+v form (v = 27 or 28), 65 bytes hex. */
    signature: string;
    /** EIP-155-adjusted transaction signature components. */
    transactionSignature: {
      r: string;
      s: string;
      v: string;
    };
  };
}

type LighterActionResult = LighterWalletResult | LighterSignResult | LighterChangePubKeyResult;

/** Derive the Lighter VM secp256k1 private key as hex from the PKP private key. */
async function deriveLighterPrivateKeyHex(pkpPrivateKeyHex: string): Promise<string> {
  return bytesToHex(await deriveKey(pkpPrivateKeyHex, "lighter-vm"));
}

/** Derive an EVM-style address from a hex-encoded secp256k1 private key. */
function lighterAddressFromPrivateKey(privateKeyHex: string): string {
  return addr.fromPrivateKey(`0x${privateKeyHex}`);
}

/** Parse a quantity and bound it to uint64/uint48/uint8-style ranges where needed. */
function parseBoundedQuantity(
  value: string | number | bigint,
  field: string,
  maxExclusive: bigint,
): bigint {
  const n = BigInt(value);
  if (n < 0n || n >= maxExclusive) {
    throw new Error(`${field} out of range`);
  }
  return n;
}

/** ABI-encode a dynamic bytes value's tail (`length || right-padded bytes`). */
function abiEncodeBytesTail(bytes: Uint8Array): Uint8Array {
  const paddedLength = Math.ceil(bytes.length / 32) * 32;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  return concatBytes(quantityToWord(bytes.length, "pubKey.length"), padded);
}

/** ABI-encode `changePubKey(uint48,uint8,bytes)` calldata for the Lighter gateway. */
function encodeChangePubKeyCalldata(
  accountIndex: bigint,
  apiKeyIndex: bigint,
  publicKey: Uint8Array,
): Uint8Array {
  const selector = keccak(new TextEncoder().encode("changePubKey(uint48,uint8,bytes)")).slice(0, 4);
  return concatBytes(
    selector,
    quantityToWord(accountIndex, "accountIndex"),
    quantityToWord(apiKeyIndex, "apiKeyIndex"),
    quantityToWord(96, "pubKey.offset"),
    abiEncodeBytesTail(publicKey),
  );
}

/** RLP-encode a byte string. */
function rlpEncodeBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 1 && bytes[0] < 0x80) {
    return bytes;
  }
  if (bytes.length <= 55) {
    return concatBytes(new Uint8Array([0x80 + bytes.length]), bytes);
  }
  const lengthBytes = bigintToMinimalBytes(BigInt(bytes.length));
  return concatBytes(new Uint8Array([0xb7 + lengthBytes.length]), lengthBytes, bytes);
}

/** Convert a bigint into its minimal big-endian representation, empty for zero. */
function bigintToMinimalBytes(value: bigint): Uint8Array {
  if (value === 0n) {
    return new Uint8Array(0);
  }
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
  }
  return hexToBytes(hex, "rlp.quantity");
}

/** RLP-encode an unsigned integer. */
function rlpEncodeUint(value: bigint): Uint8Array {
  return rlpEncodeBytes(bigintToMinimalBytes(value));
}

/** RLP-encode a list from already-RLP-encoded items. */
function rlpEncodeList(items: Uint8Array[]): Uint8Array {
  const body = concatBytes(...items);
  if (body.length <= 55) {
    return concatBytes(new Uint8Array([0xc0 + body.length]), body);
  }
  const lengthBytes = bigintToMinimalBytes(BigInt(body.length));
  return concatBytes(new Uint8Array([0xf7 + lengthBytes.length]), lengthBytes, body);
}

/** RLP-encode an unsigned EIP-155 legacy transaction for signing. */
function encodeUnsignedLegacyTransaction(input: {
  nonce: bigint;
  gasPrice: bigint;
  gasLimit: bigint;
  to: Uint8Array;
  data: Uint8Array;
  chainId: bigint;
}): Uint8Array {
  return rlpEncodeList([
    rlpEncodeUint(input.nonce),
    rlpEncodeUint(input.gasPrice),
    rlpEncodeUint(input.gasLimit),
    rlpEncodeBytes(input.to),
    rlpEncodeUint(0n),
    rlpEncodeBytes(input.data),
    rlpEncodeUint(input.chainId),
    rlpEncodeUint(0n),
    rlpEncodeUint(0n),
  ]);
}

/** RLP-encode a signed legacy transaction. */
function encodeSignedLegacyTransaction(input: {
  nonce: bigint;
  gasPrice: bigint;
  gasLimit: bigint;
  to: Uint8Array;
  data: Uint8Array;
  v: bigint;
  r: bigint;
  s: bigint;
}): Uint8Array {
  return rlpEncodeList([
    rlpEncodeUint(input.nonce),
    rlpEncodeUint(input.gasPrice),
    rlpEncodeUint(input.gasLimit),
    rlpEncodeBytes(input.to),
    rlpEncodeUint(0n),
    rlpEncodeBytes(input.data),
    rlpEncodeUint(input.v),
    rlpEncodeUint(input.r),
    rlpEncodeUint(input.s),
  ]);
}

/** Sign a 32-byte digest with secp256k1, returning r/s/recovery details. */
function signDigestDetailed(
  messageHash: Uint8Array,
  privateKeyHex: string,
): {
  signature: string;
  r: Uint8Array;
  s: Uint8Array;
  yParity: number;
} {
  const recovered = secpSign(messageHash, hexToBytes(`0x${privateKeyHex}`)).toBytes("recovered");
  const r = recovered.slice(1, 33);
  const s = recovered.slice(33, 65);
  const yParity = recovered[0];
  const signature = new Uint8Array(65);
  signature.set(r, 0);
  signature.set(s, 32);
  signature[64] = yParity === 0 ? 27 : 28;
  return { signature: `0x${bytesToHex(signature)}`, r, s, yParity };
}

/** Sign a 32-byte digest with secp256k1, returning r+s+v (v=27/28). */
function signDigest(messageHash: Uint8Array, privateKeyHex: string): string {
  return signDigestDetailed(messageHash, privateKeyHex).signature;
}

/** Return true if a Lighter API key is compiled into the environment allowlist. */
function isAllowedApiKey(apiKeyIndex: bigint, publicKeyHex: string): boolean {
  const normalizedPublicKey = normalizeHex(publicKeyHex, "changePubKey.publicKey");
  return LIGHTER_ALLOWED_API_KEYS.some(
    (key) =>
      BigInt(key.apiKeyIndex) === apiKeyIndex &&
      normalizeHex(key.publicKey, "LIGHTER_ALLOWED_API_KEYS[].publicKey") === normalizedPublicKey,
  );
}

/** Build and sign a Lighter ChangePubKey legacy transaction. */
function signChangePubKey(input: LighterChangePubKeyInput, privateKeyHex: string) {
  const accountIndex = parseBoundedQuantity(
    input.accountIndex,
    "changePubKey.accountIndex",
    1n << 48n,
  );
  const apiKeyIndex = parseBoundedQuantity(input.apiKeyIndex, "changePubKey.apiKeyIndex", 1n << 8n);
  const txNonce = parseBoundedQuantity(input.txNonce, "changePubKey.txNonce", 1n << 256n);
  const gasPrice = parseBoundedQuantity(input.gasPrice, "changePubKey.gasPrice", 1n << 256n);
  const gasLimit = parseBoundedQuantity(input.gasLimit, "changePubKey.gasLimit", 1n << 256n);
  const chainId = parseBoundedQuantity(
    LIGHTER_GATEWAY_CHAIN_ID,
    "LIGHTER_GATEWAY_CHAIN_ID",
    1n << 256n,
  );
  if (chainId === 0n) {
    throw new Error("LIGHTER_GATEWAY_CHAIN_ID out of range");
  }

  const publicKeyHex = normalizeHex(input.publicKey, "changePubKey.publicKey");
  if (!isAllowedApiKey(apiKeyIndex, publicKeyHex)) {
    throw new Error("Lighter API key is not allowlisted");
  }
  const publicKey = hexToBytes(publicKeyHex, "changePubKey.publicKey");
  if (publicKey.length === 0) {
    throw new Error("changePubKey.publicKey must be non-empty");
  }

  const gateway = hexToBytes(LIGHTER_GATEWAY, "LIGHTER_GATEWAY");
  if (gateway.length !== 20) {
    throw new Error("LIGHTER_GATEWAY must be exactly 20 bytes");
  }

  const data = encodeChangePubKeyCalldata(accountIndex, apiKeyIndex, publicKey);
  const unsignedTransaction = encodeUnsignedLegacyTransaction({
    nonce: txNonce,
    gasPrice,
    gasLimit,
    to: gateway,
    data,
    chainId,
  });
  const hash = keccak(unsignedTransaction);
  const signed = signDigestDetailed(hash, privateKeyHex);
  const eip155V = BigInt(signed.yParity) + chainId * 2n + 35n;
  const r = BigInt(`0x${bytesToHex(signed.r)}`);
  const s = BigInt(`0x${bytesToHex(signed.s)}`);
  const rawTransaction = encodeSignedLegacyTransaction({
    nonce: txNonce,
    gasPrice,
    gasLimit,
    to: gateway,
    data,
    v: eip155V,
    r,
    s,
  });

  return {
    hash: `0x${bytesToHex(hash)}`,
    data: `0x${bytesToHex(data)}`,
    unsignedTransaction: `0x${bytesToHex(unsignedTransaction)}`,
    rawTransaction: `0x${bytesToHex(rawTransaction)}`,
    signature: signed.signature,
    transactionSignature: {
      r: `0x${bytesToHex(signed.r)}`,
      s: `0x${bytesToHex(signed.s)}`,
      v: eip155V.toString(),
    },
  };
}

/** Lit Action entrypoint for wallet lookup, attestation-gated signing, and ChangePubKey. */
export async function main({
  pkpId,
  action,
  withdrawRequest,
  attestation,
  changePubKey,
}: LighterActionParams): Promise<LighterActionResult> {
  const pkpPrivateKey = await Lit.Actions.getPrivateKey({ pkpId });
  const lighterPrivateKey = await deriveLighterPrivateKeyHex(pkpPrivateKey);
  const address = lighterAddressFromPrivateKey(lighterPrivateKey);

  if (action === "wallet") {
    return {
      vmType: "lighter-vm",
      address,
    };
  }

  if (action === "sign") {
    if (!withdrawRequest) {
      throw new Error("withdrawRequest is required");
    }
    if (!attestation) {
      throw new Error("attestation is required");
    }

    const { withdrawRequestHash, hashesToSign } = verifyWithdrawRequestAttestation(
      withdrawRequest,
      attestation,
      ALLOCATOR_ADDRESS,
      HUB_EVM_CHAIN_ID,
      ALLOWED_ORACLES,
      ORACLE_SIGNATURE_THRESHOLD,
    );

    return {
      vmType: "lighter-vm",
      address,
      withdrawRequestHash: `0x${bytesToHex(withdrawRequestHash)}`,
      results: hashesToSign.map((hash) => ({
        hash: `0x${bytesToHex(hash)}`,
        signature: signDigest(hash, lighterPrivateKey),
      })),
    };
  }

  if (action === "changePubKey") {
    if (!changePubKey) {
      throw new Error("changePubKey is required");
    }
    return {
      vmType: "lighter-vm",
      address,
      changePubKey: signChangePubKey(changePubKey, lighterPrivateKey),
    };
  }

  throw new Error(`unknown action: ${action}`);
}
