/**
 * Lit Action: Hyperliquid signer.
 *
 * Runs inside Lit's TEE. Hyperliquid actions are signed with an EVM-style
 * secp256k1 key (the same scheme as ethereum-vm): the derived address is the
 * Hyperliquid sender, and the hashes proven by the oracle attestation are the
 * EIP-712 digests of the usdSend / sendAsset request.
 *
 * js_params:
 *   - pkpId:           string — PKP identifier
 *   - action:          string — "wallet" | "sign"
 *   - withdrawRequest: object — RelayAllocator WithdrawRequest (required for action=sign)
 *   - attestation:     object — oracle WithdrawRequestAttestation (required for action=sign)
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
import {
  ALLOCATOR_ADDRESS,
  ALLOWED_ORACLES,
  HUB_EVM_CHAIN_ID,
  ORACLE_SIGNATURE_THRESHOLD,
} from "../config.js";

/** `js_params` passed by the Lit Action invoker. */
interface HyperliquidActionParams {
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
interface HyperliquidWalletResult {
  vmType: "hyperliquid-vm";
  /** EIP-55-checksummed EVM address derived from the PKP. */
  address: string;
}

/** Result returned for `action="sign"`. Carries one signature per attested hash. */
interface HyperliquidSignResult extends HyperliquidWalletResult {
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

/** Derive the Hyperliquid VM secp256k1 private key as hex from the PKP private key. */
async function deriveHyperliquidPrivateKeyHex(pkpPrivateKeyHex: string): Promise<string> {
  return bytesToHex(await deriveKey(pkpPrivateKeyHex, "hyperliquid-vm"));
}

/** Derive an EVM-style address from a hex-encoded secp256k1 private key. */
function hyperliquidAddressFromPrivateKey(privateKeyHex: string): string {
  return addr.fromPrivateKey(`0x${privateKeyHex}`);
}

/** Sign a 32-byte digest with secp256k1, returning r+s+v (v=27/28). */
function signDigest(messageHash: Uint8Array, privateKeyHex: string): string {
  const recovered = secpSign(messageHash, hexToBytes(`0x${privateKeyHex}`)).toBytes("recovered");
  const signature = new Uint8Array(65);
  signature.set(recovered.slice(1), 0);
  signature[64] = recovered[0] === 0 ? 27 : 28;
  return `0x${bytesToHex(signature)}`;
}

/** Lit Action entrypoint for wallet lookup and attestation-gated Hyperliquid signing. */
export async function main({
  pkpId,
  action,
  withdrawRequest,
  attestation,
}: HyperliquidActionParams): Promise<HyperliquidWalletResult | HyperliquidSignResult> {
  const pkpPrivateKey = await Lit.Actions.getPrivateKey({ pkpId });
  const hyperliquidPrivateKey = await deriveHyperliquidPrivateKeyHex(pkpPrivateKey);

  if (action === "wallet") {
    return {
      vmType: "hyperliquid-vm",
      address: hyperliquidAddressFromPrivateKey(hyperliquidPrivateKey),
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
      vmType: "hyperliquid-vm",
      address: hyperliquidAddressFromPrivateKey(hyperliquidPrivateKey),
      withdrawRequestHash: `0x${bytesToHex(withdrawRequestHash)}`,
      results: hashesToSign.map((hash) => ({
        hash: `0x${bytesToHex(hash)}`,
        signature: signDigest(hash, hyperliquidPrivateKey),
      })),
    };
  }

  throw new Error(`unknown action: ${action}`);
}
