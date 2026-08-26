/**
 * Lit Action: Circle Gateway signer
 *
 * Runs inside Lit's TEE. Derives dedicated Gateway key material and signs the
 * Circle BurnIntent with secp256k1 plus destination payloads with the curve
 * native to the requested destination VM
 *
 * js_params:
 *   - pkpId:           string — PKP identifier
 *   - action:          string — "wallet" | "sign"
 *   - destinationVmType: string — "ethereum-vm" | "solana-vm"
 *   - withdrawRequest: object — RelayAllocator WithdrawRequest (required for action=sign)
 *   - attestation:     object — oracle WithdrawRequestAttestation (required for action=sign)
 */
import { addr } from "https://cdn.jsdelivr.net/npm/micro-eth-signer@0.18.1/+esm";
import { sign as secpSign } from "https://cdn.jsdelivr.net/npm/micro-eth-signer@0.18.1/utils.js/+esm";
import bs58 from "https://cdn.jsdelivr.net/npm/bs58@6.0.0/+esm";
import nacl from "https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/+esm";
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

type GatewayDestinationVmType = "ethereum-vm" | "solana-vm";

interface GatewayActionParams {
  pkpId: string;
  action: "wallet" | "sign" | string;
  destinationVmType: "ethereum-vm" | "solana-vm" | string;
  withdrawRequest?: WithdrawRequest;
  attestation?: WithdrawRequestAttestation;
}

interface GatewayWalletResult {
  vmType: "gateway-vm";
  destinationVmType: GatewayDestinationVmType;
  gatewaySigner: string;
  address: string;
}

interface GatewaySignResult extends GatewayWalletResult {
  withdrawRequestHash: string;
  results: Array<{
    hash: string;
    signature: string;
  }>;
}

/** Sign a 32-byte digest with secp256k1, returning r+s+v (v=27/28) */
function signDigest(messageHash: Uint8Array, privateKeyHex: string): string {
  const recovered = secpSign(messageHash, hexToBytes(`0x${privateKeyHex}`)).toBytes("recovered");
  const signature = new Uint8Array(65);
  signature.set(recovered.slice(1), 0);
  signature[64] = recovered[0] === 0 ? 27 : 28;
  return `0x${bytesToHex(signature)}`;
}

/** Lit Action entrypoint for Gateway wallet lookup and dual signing */
export async function main({
  pkpId,
  action,
  destinationVmType,
  withdrawRequest,
  attestation,
}: GatewayActionParams): Promise<GatewayWalletResult | GatewaySignResult> {
  if (destinationVmType !== "ethereum-vm" && destinationVmType !== "solana-vm") {
    throw new Error(`unsupported destinationVmType: ${destinationVmType}`);
  }
  const resolvedDestinationVmType = destinationVmType as GatewayDestinationVmType;

  const pkpPrivateKey = await Lit.Actions.getPrivateKey({ pkpId });
  const gatewayKey = await deriveKey(pkpPrivateKey, "gateway-vm");
  const gatewayPrivateKey = bytesToHex(gatewayKey);
  const gatewaySigner = addr.fromPrivateKey(`0x${gatewayPrivateKey}`);
  const solanaKeyPair =
    resolvedDestinationVmType === "solana-vm" ? nacl.sign.keyPair.fromSeed(gatewayKey) : undefined;
  const address = solanaKeyPair ? bs58.encode(solanaKeyPair.publicKey) : gatewaySigner;
  const wallet = {
    vmType: "gateway-vm" as const,
    destinationVmType: resolvedDestinationVmType,
    gatewaySigner,
    address,
  };

  if (action === "wallet") {
    return wallet;
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
      ...wallet,
      withdrawRequestHash: `0x${bytesToHex(withdrawRequestHash)}`,
      results: hashesToSign.map((hash, index) => ({
        hash: `0x${bytesToHex(hash)}`,
        signature:
          index === 0 || resolvedDestinationVmType === "ethereum-vm"
            ? signDigest(hash, gatewayPrivateKey)
            : bytesToHex(nacl.sign.detached(hash, solanaKeyPair!.secretKey)),
      })),
    };
  }

  throw new Error(`unknown action: ${action}`);
}
