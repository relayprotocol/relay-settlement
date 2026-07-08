/**
 * Lit Action: XRP Ledger signer.
 *
 * Runs inside Lit's TEE. Derives a deterministic XRPL account from the PKP
 * private key via HKDF-SHA256 (info = "xrp-vm", so the secp256k1 keypair does
 * not collide with Bitcoin's) and signs withdraw request hashes proven by an
 * oracle attestation.
 *
 * XRPL is unique among the allocator VMs in that the signing public key is
 * embedded verbatim in every transaction (the `SigningPubKey` field), so the
 * compressed secp256k1 public key is returned alongside the address. That key
 * is also the value baked into `XrpVmPayloadBuilder`'s `SIGNING_PUBKEY`
 * constructor argument on chain.
 *
 * The hashes handed to `sign` are already the XRPL single-signing digest
 * (SHA-512Half of the `STX\0`-prefixed serialized transaction), so they are
 * signed as-is — `prehash: false` — and returned as canonical, low-S,
 * DER-encoded ECDSA signatures, which is the encoding XRPL's `TxnSignature`
 * field expects.
 *
 * js_params:
 *   - pkpId:           string — PKP identifier
 *   - action:          string — "wallet" | "sign"
 *   - withdrawRequest: object — RelayAllocator WithdrawRequest (required for action=sign)
 *   - attestation:     object — oracle WithdrawRequestAttestation (required for action=sign)
 */
import { secp256k1 } from "https://cdn.jsdelivr.net/npm/@noble/curves@2.0.1/secp256k1.js/+esm";
import { ripemd160 } from "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/legacy.js/+esm";
import { sha256 } from "https://cdn.jsdelivr.net/npm/@noble/hashes@2.0.1/sha2.js/+esm";
import {
  bytesToHex,
  deriveKey,
  verifyWithdrawRequestAttestation,
  type WithdrawRequestAttestation,
  type WithdrawRequest,
} from "../common/index.js";
import {
  ALLOCATOR_ADDRESS,
  ALLOWED_ORACLES,
  HUB_EVM_CHAIN_ID,
  ORACLE_SIGNATURE_THRESHOLD,
} from "../config.js";

/** Ripple's base58 dictionary — a permutation of the Bitcoin alphabet. */
const XRPL_ALPHABET = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";

/** Version byte prepended to a 20-byte AccountID before base58check (yields "r..."). */
const ACCOUNT_ID_PREFIX = 0x00;

interface XrpActionParams {
  pkpId: string;
  action: "wallet" | "sign" | string;
  withdrawRequest?: WithdrawRequest;
  attestation?: WithdrawRequestAttestation;
}

interface XrpWalletResult {
  vmType: "xrp-vm";
  /** Classic XRPL account address (r...). */
  address: string;
  /**
   * 33-byte compressed secp256k1 public key (0x-prefixed hex). XRPL embeds it
   * as the transaction `SigningPubKey`, and it is the value baked into
   * `XrpVmPayloadBuilder`'s `SIGNING_PUBKEY` constructor argument on chain.
   * It is a fixed per-PKP constant, so it is surfaced only here (used once at
   * deploy time) and not repeated on every `sign` response.
   */
  signingPubKey: string;
}

interface XrpSignResult {
  vmType: "xrp-vm";
  /** Classic XRPL account address (r...). */
  address: string;
  withdrawRequestHash: string;
  results: Array<{
    hash: string;
    /** Canonical low-S DER-encoded secp256k1 signature (0x-prefixed hex). */
    signature: string;
  }>;
}

/** Derive the XRP VM secp256k1 private key from the PKP private key. */
async function deriveXrpPrivateKey(pkpPrivateKeyHex: string): Promise<Uint8Array> {
  return deriveKey(pkpPrivateKeyHex, "xrp-vm");
}

/** Base58 encode raw bytes using the XRPL alphabet (big-endian, with leading-zero preservation). */
function base58Xrpl(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) {
    value = value * 256n + BigInt(byte);
  }
  let out = "";
  while (value > 0n) {
    out = XRPL_ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) {
      break;
    }
    out = XRPL_ALPHABET[0] + out;
  }
  return out;
}

/**
 * Encode a 20-byte AccountID as a classic XRPL address: base58check over
 * `0x00 ‖ accountId` with a double-SHA-256 4-byte checksum.
 */
function encodeAccountId(accountId: Uint8Array): string {
  const payload = new Uint8Array(1 + accountId.length);
  payload[0] = ACCOUNT_ID_PREFIX;
  payload.set(accountId, 1);
  const checksum = sha256(sha256(payload)).slice(0, 4);
  const full = new Uint8Array(payload.length + 4);
  full.set(payload, 0);
  full.set(checksum, payload.length);
  return base58Xrpl(full);
}

/** Compressed secp256k1 public key for the derived private key. */
function signingPubKey(privateKey: Uint8Array): Uint8Array {
  return secp256k1.getPublicKey(privateKey, true);
}

/** Classic XRPL address = base58check(RIPEMD160(SHA256(compressed public key))). */
function xrpAddress(publicKey: Uint8Array): string {
  return encodeAccountId(ripemd160(sha256(publicKey)));
}

/**
 * Sign an XRPL single-signing digest. The hash is already SHA-512Half of the
 * serialized transaction, so it is signed directly (no prehash). XRPL requires
 * canonical low-S DER signatures, both of which are @noble/curves defaults.
 */
function signDigest(digest: Uint8Array, privateKey: Uint8Array): string {
  const der = secp256k1.sign(digest, privateKey, { prehash: false, format: "der" });
  return `0x${bytesToHex(der)}`;
}

/** Lit Action entrypoint for wallet lookup and attestation-gated XRPL signing. */
export async function main({
  pkpId,
  action,
  withdrawRequest,
  attestation,
}: XrpActionParams): Promise<XrpWalletResult | XrpSignResult> {
  const pkpPrivateKey = await Lit.Actions.getPrivateKey({ pkpId });
  const privateKey = await deriveXrpPrivateKey(pkpPrivateKey);
  const publicKey = signingPubKey(privateKey);
  const address = xrpAddress(publicKey);

  if (action === "wallet") {
    return {
      vmType: "xrp-vm",
      address,
      signingPubKey: `0x${bytesToHex(publicKey)}`,
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
      vmType: "xrp-vm",
      address,
      withdrawRequestHash: `0x${bytesToHex(withdrawRequestHash)}`,
      results: hashesToSign.map((hash) => ({
        hash: `0x${bytesToHex(hash)}`,
        signature: signDigest(hash, privateKey),
      })),
    };
  }

  throw new Error(`unknown action: ${action}`);
}
