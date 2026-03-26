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
 *
 * | VM              | Wallet method       | Input to wallet                        |
 * |-----------------|---------------------|----------------------------------------|
 * | EVM/Hyperliquid | personal_sign       | raw bytes: { raw: "0x" + digest }      |
 * | Tron            | signMessageV2       | hex string: digest                     |
 * | Solana          | signMessage         | UTF-8 bytes of hex string              |
 * | Bitcoin         | signMessage         | hex string: digest                     |
 * | Sui             | signPersonalMessage | UTF-8 bytes of hex string              |
 */
export async function signWithdrawalDigest(
  vmType: string,
  digest: string,
  wallet: any
): Promise<string> {
  switch (vmType) {
    case "evm":
    case "hypevm":
      return signWithdrawalEvm(wallet as WalletClient, digest)

    case "svm":
      // TODO: Solana — wallet.signMessage(new TextEncoder().encode(digest))
      throw new Error("Solana signing not yet supported")

    case "bvm":
      // TODO: Bitcoin — wallet.signMessage(digest)
      throw new Error("Bitcoin signing not yet supported")

    case "tvm":
      // TODO: Tron — tronWeb.trx.signMessageV2(digest)
      throw new Error("Tron signing not yet supported")

    case "suivm":
      // TODO: Sui — wallet.signPersonalMessage(new TextEncoder().encode(digest))
      throw new Error("Sui signing not yet supported")

    default:
      throw new Error(`Unsupported VM type for signing: ${vmType}`)
  }
}

/**
 * EVM signing — personal_sign with raw bytes.
 * Oracle verifies with viem.verifyMessage({ message: { raw } }).
 */
async function signWithdrawalEvm(
  walletClient: WalletClient,
  digest: string
): Promise<`0x${string}`> {
  const account = walletClient.account
  if (!account) throw new Error("Wallet not connected")

  return walletClient.signMessage({
    account,
    message: { raw: `0x${digest}` as `0x${string}` },
  })
}
