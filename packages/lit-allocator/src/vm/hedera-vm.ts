/**
 * Lit Action: Hedera signer.
 *
 * Runs inside Lit's TEE. Derives a deterministic secp256k1 keypair from the PKP
 * private key via HKDF-SHA256 (info = "hedera-vm", so the key does not collide
 * with Ethereum's) and signs withdraw request hashes proven by an oracle
 * attestation.
 *
 * The hashes handed to `sign` are already the keccak256 digest of the
 * serialized Hedera `TransactionBody` — the value Hedera verifies an ECDSA
 * secp256k1 signature against — so they are signed as-is (`prehash: false`).
 *
 * Signatures are returned as raw 64-byte r‖s, which is the encoding Hedera's
 * `SignaturePair.ECDSA_secp256k1` field carries. This is deliberately *not* the
 * 65-byte r‖s‖v form the Ethereum action emits: Hedera has no recovery byte,
 * and the public key travels separately in `SignaturePair.pubKeyPrefix`.
 *
 * ── On the wallet address ────────────────────────────────────────────────────
 * Unlike every other VM here, the address this action derives is not yet a
 * usable account. Hedera accounts are created, not merely addressed: the
 * derived key yields an EVM alias, and only once an account has been created
 * for it on the network does it gain the `shard.realm.num` entity id that the
 * protocol uses as the depository identity.
 *
 * So `action="wallet"` returns the alias plus the compressed public key, and
 * the operator then creates the account (an `AccountCreateTransaction` keyed to
 * that public key), reads the resulting `0.0.x` entity id back from the mirror
 * node, and registers *that* as the depository. `HederaVmPayloadBuilder` reads
 * the payer out of a long-zero address and rejects an alias with
 * `NotAnAccountId`, so the entity id — not this address — is the value to
 * configure on chain.
 *
 * js_params:
 *   - pkpId:           string — PKP identifier
 *   - action:          string — "wallet" | "sign"
 *   - withdrawRequest: object — RelayAllocator WithdrawRequest (required for action=sign)
 *   - attestation:     object — oracle WithdrawRequestAttestation (required for action=sign)
 */
import { secp256k1 } from "https://cdn.jsdelivr.net/npm/@noble/curves@2.0.1/secp256k1.js/+esm";
import { addr } from "https://cdn.jsdelivr.net/npm/micro-eth-signer@0.18.1/+esm";
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

/** `js_params` passed by the Lit Action invoker. */
interface HederaActionParams {
  /** PKP identifier whose private key the action reconstructs inside the TEE. */
  pkpId: string;
  /** `"wallet"` to return only the derived address; `"sign"` to also sign attested hashes. */
  action: "wallet" | "sign" | string;
  /** Original withdraw request fields. Required for `action="sign"`. */
  withdrawRequest?: WithdrawRequest;
  /** Oracle attestation containing the hashes to sign. Required for `action="sign"`. */
  attestation?: WithdrawRequestAttestation;
}

/** Result returned for `action="wallet"`. */
interface HederaWalletResult {
  vmType: "hedera-vm";
  /**
   * EVM alias of the derived key (EIP-55 checksummed). This is the address an
   * account is created *for*, not an account id — see the note above on why the
   * depository is the resulting `0.0.x` entity id instead.
   */
  address: string;
  /**
   * 33-byte compressed secp256k1 public key (0x-prefixed hex). Needed twice
   * off-chain: to create the Hedera account keyed to it, and as the
   * `SignaturePair.pubKeyPrefix` accompanying every signature. It is a fixed
   * per-PKP constant, so it is surfaced only here and not repeated on every
   * `sign` response.
   */
  publicKey: string;
}

/** Result returned for `action="sign"`. Carries one signature per attested hash. */
interface HederaSignResult {
  vmType: "hedera-vm";
  /** EVM alias of the derived key (EIP-55 checksummed). */
  address: string;
  /** keccak256(abi.encode(withdrawRequest)) as a 0x-prefixed hex string. */
  withdrawRequestHash: string;
  /** One entry per `attestation.hashesToSign`, in input order. */
  results: Array<{
    /** The signed digest as a 0x-prefixed hex string. */
    hash: string;
    /** Canonical low-S secp256k1 signature as raw 64-byte r‖s (0x-prefixed hex). */
    signature: string;
  }>;
}

/** Derive the Hedera VM secp256k1 private key from the PKP private key. */
async function deriveHederaPrivateKey(pkpPrivateKeyHex: string): Promise<Uint8Array> {
  return deriveKey(pkpPrivateKeyHex, "hedera-vm");
}

/** Compressed secp256k1 public key for the derived private key. */
function compressedPublicKey(privateKey: Uint8Array): Uint8Array {
  return secp256k1.getPublicKey(privateKey, true);
}

/**
 * EVM alias for the derived key. Hedera derives an account's alias exactly as
 * Ethereum derives an address, so the same helper applies.
 */
function hederaEvmAlias(privateKey: Uint8Array): string {
  return addr.fromPrivateKey(`0x${bytesToHex(privateKey)}`);
}

/**
 * Sign a Hedera transaction body digest. The hash is already keccak256 of the
 * serialized body, so it is signed directly (no prehash). Hedera requires a
 * canonical low-S signature in raw 64-byte r‖s form, which is @noble/curves'
 * default output format.
 */
function signDigest(digest: Uint8Array, privateKey: Uint8Array): string {
  const signature = secp256k1.sign(digest, privateKey, { prehash: false });
  return `0x${bytesToHex(signature)}`;
}

/** Lit Action entrypoint for wallet lookup and attestation-gated Hedera signing. */
export async function main({
  pkpId,
  action,
  withdrawRequest,
  attestation,
}: HederaActionParams): Promise<HederaWalletResult | HederaSignResult> {
  const pkpPrivateKey = await Lit.Actions.getPrivateKey({ pkpId });
  const privateKey = await deriveHederaPrivateKey(pkpPrivateKey);
  const address = hederaEvmAlias(privateKey);

  if (action === "wallet") {
    return {
      vmType: "hedera-vm",
      address,
      publicKey: `0x${bytesToHex(compressedPublicKey(privateKey))}`,
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
      vmType: "hedera-vm",
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
