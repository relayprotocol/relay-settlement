/**
 * Lit Action: TON signer.
 *
 * Runs inside Lit's TEE. Derives a deterministic TON wallet via HKDF-SHA256
 * (info = "ton-vm", so the keypair does not collide with Solana's) and signs
 * a withdraw request hash proven by an oracle attestation.
 *
 * The wallet address is returned as a raw TON workchain-0 std address of the
 * form `0:<32-byte hex>`. Consumers can convert to friendly base64url via
 * `@ton/core`'s `Address.parseRaw()` if needed.
 *
 * js_params:
 *   - pkpId:           string — PKP identifier
 *   - action:          string — "wallet" | "sign"
 *   - withdrawRequest: object — RelayAllocator WithdrawRequest (required for action=sign)
 *   - attestation:     object — oracle WithdrawRequestAttestation (required for action=sign)
 */
import nacl from "https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/+esm";
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

interface TonActionParams {
  pkpId: string;
  action: "wallet" | "sign" | string;
  withdrawRequest?: WithdrawRequest;
  attestation?: WithdrawRequestAttestation;
}

interface TonWalletResult {
  vmType: "ton-vm";
  address: string;
}

interface TonSignResult extends TonWalletResult {
  withdrawRequestHash: string;
  results: Array<{
    hash: string;
    signature: string;
  }>;
}

/** Raw TON workchain-0 std address: `0:<32-byte hex>`. */
function tonAddress(publicKey: Uint8Array): string {
  return `0:${bytesToHex(publicKey)}`;
}

/** Derive the TON VM Ed25519 seed from the PKP private key. */
async function deriveTonSeed(pkpPrivateKeyHex: string): Promise<Uint8Array> {
  return deriveKey(pkpPrivateKeyHex, "ton-vm");
}

/** Lit Action entrypoint for wallet lookup and attestation-gated TON signing. */
export async function main({
  pkpId,
  action,
  withdrawRequest,
  attestation,
}: TonActionParams): Promise<TonWalletResult | TonSignResult> {
  const pkpPrivateKey = await Lit.Actions.getPrivateKey({ pkpId });
  const seed = await deriveTonSeed(pkpPrivateKey);
  const keyPair = nacl.sign.keyPair.fromSeed(seed);

  if (action === "wallet") {
    return {
      vmType: "ton-vm",
      address: tonAddress(keyPair.publicKey),
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
      vmType: "ton-vm",
      address: tonAddress(keyPair.publicKey),
      withdrawRequestHash: `0x${bytesToHex(withdrawRequestHash)}`,
      results: hashesToSign.map((hash) => ({
        hash: `0x${bytesToHex(hash)}`,
        signature: bytesToHex(nacl.sign.detached(hash, keyPair.secretKey)),
      })),
    };
  }

  throw new Error(`unknown action: ${action}`);
}
