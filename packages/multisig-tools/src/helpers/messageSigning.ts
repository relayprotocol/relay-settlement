import { recoverAddress } from "viem"
import {
  buildMessage,
  getSignatureForHash,
  type Transaction,
} from "../builders/utils"
import type { ResolvedNetwork } from "./network"

export async function signMessageEntry(
  entry: Extract<Transaction, { family: "message" }>,
  multisigSigner: `0x${string}`,
  clients: Pick<ResolvedNetwork, "publicClient" | "walletClient">
) {
  const built = buildMessage(entry)
  const hash = built.hashesToSign[0]
  const signature = (await getSignatureForHash(
    multisigSigner,
    hash,
    "Ecdsa",
    clients
  )) as `0x${string}`
  return verifyMessageSignature(entry, signature)
}

// Shared by signature collection and consumers of saved signature artifacts.
export async function verifyMessageSignature(
  entry: Extract<Transaction, { family: "message" }>,
  signature: `0x${string}`
) {
  const built = buildMessage(entry)
  const hash = built.hashesToSign[0]
  const signer = await recoverAddress({ hash, signature })
  if (signer.toLowerCase() !== entry.from.toLowerCase()) {
    throw new Error("Message signature does not match the expected signer")
  }
  return {
    description: entry.description,
    from: entry.from,
    hash,
    signature,
  }
}
