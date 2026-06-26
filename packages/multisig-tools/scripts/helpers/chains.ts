import { createPublicClient, http } from "viem"
import { deriveAllocatorSignerAddress } from "../../src/crypto/signer"
import {
  relay as relayChain,
  aurora,
} from "@relay-protocol/settlement-networks"

// relay chain

export function createRelayChainClient() {
  const client = createPublicClient({
    transport: http(relayChain.rpc[0]),
  })
  return { client, rpcUrl: relayChain.rpc[0] }
}
export const RELAY_CHAIN_HUB_ADDRESS =
  "0xDDD361727C22A01EB137880678A20b0BEaE69318"
export const RELAY_CHAIN_GAS_CONFIG = {
  maxFeePerGas: 7n,
  maxPriorityFeePerGas: 0n,
} as const

// aurora
export async function getSignerAddress() {
  const multisigSigner = aurora.contracts?.prod?.multisigSigner
  if (!multisigSigner) throw new Error("MultisigSigner not found")

  const auroraClient = createPublicClient({
    transport: http(aurora.rpc[0]),
  })

  const signerAddress = await deriveAllocatorSignerAddress(
    auroraClient,
    multisigSigner,
    "ethereum-vm"
  )
  if (!signerAddress) throw new Error("Failed to derive signer")
  return signerAddress
}
