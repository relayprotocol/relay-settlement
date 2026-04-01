import stringify from "json-stable-stringify"
import { sha256, toHex } from "viem"
import type { WalletClient } from "viem"

/**
 * Build the SHA256 digest for withdrawal signing.
 * Must match solver's buildSigningMessage() exactly.
 * This is VM-agnostic — same digest for all VMs.
 */
export function computeWithdrawalDigest(params: {
  chainId: string
  currency: string
  amount: string
  ownerChainId: string
  owner: string
  recipient: string
  nonce: string
  additionalData?: Record<string, unknown>
}): string {
  const json = stringify({
    chainId: params.chainId,
    currency: params.currency,
    amount: params.amount,
    ownerChainId: params.ownerChainId,
    owner: params.owner,
    recipient: params.recipient,
    nonce: params.nonce,
    additionalData: params.additionalData,
  })!

  const hash = sha256(toHex(json))
  return hash.slice(2)
}

/**
 * Per-VM signing — dispatches to the correct wallet signing method.
 * Returns 0x-prefixed hex signature for the oracle API.
 *
 * Reference: workspace-new/reference/test-signing.html
 * Each VM uses its native wallet API → gets raw bytes → converts to 0x hex.
 * Oracle expects ownerSignature as hex string (optional 0x prefix).
 *
 * | VM              | Wallet API                              | Raw format  | Oracle verification      |
 * |-----------------|-----------------------------------------|-------------|--------------------------|
 * | EVM/Hyperliquid | personal_sign(raw bytes)                | hex         | viem verifyMessage       |
 * | Solana          | signMessage(UTF-8 bytes of hex string)  | Uint8Array  | Ed25519 verify           |
 * | Bitcoin         | signMessage(hex string)                 | base64      | bitcoinjs-message/BIP322 |
 * | Tron            | signMessageV2(hex string)               | hex         | keccak256 recovery       |
 * | Sui             | signPersonalMessage(UTF-8 bytes)        | base64      | @mysten/sui verify       |
 */
export async function signWithdrawalDigest(
  vmType: string,
  digest: string,
  wallet: any
): Promise<string> {
  switch (vmType) {
    case "evm":
    case "hypevm":
      return signEvm(wallet as WalletClient, digest)
    case "svm":
      return signSolana(wallet, digest)
    case "bvm":
      return signBitcoin(wallet, digest)
    case "tvm":
      return signTron(wallet, digest)
    case "suivm":
      return signSui(wallet, digest)
    default:
      throw new Error(`Unsupported VM type for signing: ${vmType}`)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function bytesToHex(buf: Uint8Array): string {
  return (
    "0x" +
    Array.from(buf)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  )
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function ensureHexPrefix(sig: string): string {
  return sig.startsWith("0x") ? sig : `0x${sig}`
}

// ---------------------------------------------------------------------------
// EVM / Hyperliquid — personal_sign with raw SHA256 bytes
// ---------------------------------------------------------------------------

async function signEvm(
  walletClient: WalletClient,
  digest: string
): Promise<string> {
  const account = walletClient.account
  if (!account) throw new Error("Wallet not connected")

  return walletClient.signMessage({
    account,
    message: { raw: `0x${digest}` as `0x${string}` },
  })
}

// ---------------------------------------------------------------------------
// Solana — Ed25519 signMessage over UTF-8 bytes of hex string
// Phantom returns Uint8Array → convert directly to hex
// Reference: test-signing.html lines 499-507
// ---------------------------------------------------------------------------

async function signSolana(wallet: any, digest: string): Promise<string> {
  // Dynamic's wallet.signMessage(string) → base64 string
  // Internally: TextEncoder → provider.signMessage → bufferToBase64(signature bytes)
  // Source: @dynamic-labs/solana SolProviderHelper.signMessage
  if (typeof wallet.signMessage !== "function") {
    throw new Error("Solana wallet does not support message signing")
  }
  const sig = await wallet.signMessage(digest)
  if (!sig) throw new Error("Signing cancelled")
  return bytesToHex(base64ToBytes(sig))
}

// ---------------------------------------------------------------------------
// Bitcoin — signMessage over hex string → 0x-hex BIP-137 (65 bytes)
// Dynamic's Bitcoin wallet returns 0x-prefixed hex directly (65 bytes BIP-137).
// Header byte uses P2PKH flag (e.g. 0x20), but oracle verifies with
// checkSegwitAlways=true which also tries P2WPKH — so bc1q addresses work.
// Reference: test-signing.html lines 527-535
// ---------------------------------------------------------------------------

async function signBitcoin(wallet: any, digest: string): Promise<string> {
  if (typeof wallet.signMessage !== "function") {
    throw new Error("Bitcoin wallet does not support message signing")
  }

  const sig = await wallet.signMessage(digest)
  if (!sig) throw new Error("Signing cancelled")

  // Dynamic returns 0x-prefixed hex (65 bytes BIP-137)
  if (sig.startsWith("0x")) return sig

  // Other wallets (Xverse/Unisat direct) return base64 — decode to hex
  const sigBytes = base64ToBytes(sig)
  return bytesToHex(sigBytes)
}

// ---------------------------------------------------------------------------
// Tron — signMessageV2 over hex string → returns hex
// Must use tronWeb.trx.signMessageV2 (adds "\x19TRON Signed Message:\n" prefix)
// Dynamic's wallet.signMessage() may not map to signMessageV2
// Reference: test-signing.html lines 490-497
// ---------------------------------------------------------------------------

async function signTron(wallet: any, digest: string): Promise<string> {
  // Use TronWeb's signMessageV2 directly — matches oracle verification
  // Dynamic TronWallet exposes getTronWeb()
  const tronWeb = wallet.getTronWeb?.()
  if (tronWeb?.trx?.signMessageV2) {
    const sig = await tronWeb.trx.signMessageV2(digest)
    if (!sig) throw new Error("Signing cancelled")
    return ensureHexPrefix(sig)
  }

  // Dynamic's generic signMessage() does NOT apply the "\x19TRON Signed Message:\n"
  // prefix that the oracle expects — using it would produce an invalid signature.
  throw new Error(
    "Tron wallet does not expose TronWeb. Connect a TronLink-compatible wallet."
  )
}

// ---------------------------------------------------------------------------
// Sui — signPersonalMessage over UTF-8 bytes of hex string → base64 → hex
// Must pass UTF-8 encoded bytes, not raw hex bytes
// Reference: test-signing.html lines 563-588
// ---------------------------------------------------------------------------

async function signSui(wallet: any, digest: string): Promise<string> {
  const digestUtf8 = new TextEncoder().encode(digest)

  // Dynamic SuiWallet: use getSigner() for raw byte-level signing
  if (typeof wallet.getSigner === "function") {
    const signer = await wallet.getSigner()
    if (typeof signer.signPersonalMessage === "function") {
      const resp = await signer.signPersonalMessage({ message: digestUtf8 })
      const sig = resp?.signature ?? resp
      if (!sig) throw new Error("Signing cancelled")
      if (typeof sig === "string") {
        if (sig.startsWith("0x")) return sig
        return bytesToHex(base64ToBytes(sig))
      }
      return bytesToHex(new Uint8Array(sig))
    }
  }

  // Fallback: Dynamic's signMessage(string)
  if (typeof wallet.signMessage === "function") {
    const sig = await wallet.signMessage(digest)
    if (!sig) throw new Error("Signing cancelled")
    if (sig.startsWith("0x")) return sig
    return bytesToHex(base64ToBytes(sig))
  }

  throw new Error("Sui wallet does not support message signing")
}
