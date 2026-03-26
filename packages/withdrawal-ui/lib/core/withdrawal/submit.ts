import type { Address, WalletClient } from "viem"
import type { EvmTransactionData } from "./types"

/**
 * Per-VM transaction submission — dispatches to the correct wallet method.
 *
 * | VM              | Transaction format                                    |
 * |-----------------|-------------------------------------------------------|
 * | EVM             | { from, to, data, value, chainId, gas, ... }          |
 * | Solana          | { instructions, addressLookupTableAddresses }          |
 * | Bitcoin         | { psbt }                                              |
 * | Tron            | { parameter, type }                                   |
 * | Sui             | { data }                                              |
 * | Hyperliquid     | { action, nonce, eip712Types, signer, signature, ... }|
 */
export async function submitTransaction(
  vmType: string,
  transaction: any,
  wallet: any
): Promise<string> {
  switch (vmType) {
    case "evm":
      return submitEvmTransaction(
        wallet as WalletClient,
        transaction as EvmTransactionData
      )

    case "svm":
      // TODO: Solana — build Transaction from instructions, wallet.sendTransaction()
      throw new Error("Solana transaction submission not yet supported")

    case "bvm":
      // TODO: Bitcoin — sign PSBT, broadcast
      throw new Error("Bitcoin transaction submission not yet supported")

    case "tvm":
      // TODO: Tron — tronWeb.trx.sendTransaction()
      throw new Error("Tron transaction submission not yet supported")

    case "suivm":
      // TODO: Sui — wallet.signAndExecuteTransactionBlock()
      throw new Error("Sui transaction submission not yet supported")

    case "hypevm":
      // TODO: Hyperliquid — EIP-712 signed action, submit via API
      throw new Error("Hyperliquid transaction submission not yet supported")

    default:
      throw new Error(`Unsupported VM type for transaction: ${vmType}`)
  }
}

async function submitEvmTransaction(
  walletClient: WalletClient,
  tx: EvmTransactionData
): Promise<string> {
  const account = walletClient.account
  if (!account) throw new Error("Wallet not connected")

  return walletClient.sendTransaction({
    account,
    chain: null,
    to: tx.to as Address,
    data: tx.data as `0x${string}`,
    value: BigInt(tx.value),
    chainId: tx.chainId,
    gas: tx.gas ? BigInt(tx.gas) : undefined,
  })
}
