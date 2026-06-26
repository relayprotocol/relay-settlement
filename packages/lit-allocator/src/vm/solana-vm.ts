/**
 * Lit Action: Solana signer.
 *
 * Runs inside Lit's TEE. Derives a deterministic Solana wallet via HKDF-SHA256
 * and signs a withdraw request hash proven by an oracle attestation.
 *
 * js_params:
 *   - pkpId:           string — PKP identifier
 *   - action:          string — "wallet" | "sign"
 *   - withdrawRequest: object — RelayAllocator WithdrawRequest (required for action=sign)
 *   - attestation:     object — oracle WithdrawRequestAttestation (required for action=sign)
 */
import nacl from "https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/+esm";
import bs58 from "https://cdn.jsdelivr.net/npm/bs58@6.0.0/+esm";
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

interface SolanaActionParams {
  pkpId: string;
  action: "wallet" | "sign" | string;
  withdrawRequest?: WithdrawRequest;
  attestation?: WithdrawRequestAttestation;
}

interface SolanaWalletResult {
  vmType: "solana-vm";
  address: string;
}

interface SolanaSignResult extends SolanaWalletResult {
  withdrawRequestHash: string;
  results: Array<{
    hash: string;
    signature: string;
  }>;
}

/** Derive the Solana VM Ed25519 seed from the PKP private key. */
async function deriveSolanaSeed(pkpPrivateKeyHex: string): Promise<Uint8Array> {
  return deriveKey(pkpPrivateKeyHex, "solana-vm");
}

/** Lit Action entrypoint for wallet lookup and attestation-gated Solana signing. */
export async function main({
  pkpId,
  action,
  withdrawRequest,
  attestation,
}: SolanaActionParams): Promise<SolanaWalletResult | SolanaSignResult> {
  const pkpPrivateKey = await Lit.Actions.getPrivateKey({ pkpId });
  const seed = await deriveSolanaSeed(pkpPrivateKey);
  const keyPair = nacl.sign.keyPair.fromSeed(seed);

  if (action === "wallet") {
    return {
      vmType: "solana-vm",
      address: bs58.encode(keyPair.publicKey),
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
      vmType: "solana-vm",
      address: bs58.encode(keyPair.publicKey),
      withdrawRequestHash: `0x${bytesToHex(withdrawRequestHash)}`,
      results: hashesToSign.map((hash) => ({
        hash: `0x${bytesToHex(hash)}`,
        signature: bytesToHex(nacl.sign.detached(hash, keyPair.secretKey)),
      })),
    };
  }

  throw new Error(`unknown action: ${action}`);
}
