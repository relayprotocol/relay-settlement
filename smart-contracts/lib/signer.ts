import { networks } from "@relay-protocol/networks"
import { ChainType } from "@relay-protocol/types"
import { base58 } from "@scure/base"
import { publicKeyToAddress } from "viem/accounts"
import { derivePublicKey } from "./near"
import * as bitcoin from "bitcoinjs-lib"

// EdDSA for Solana, ECDSA for EVM and Bitcoin
export const getDomainId = (family: ChainType) =>
  family === "solana-vm" ? 1 : 0

export const deriveAllocatorSignerAddress = async (
  publicClient: any,
  allocatorAddress: string,
  family: ChainType,
  network?: string = "bitcoin"
): Promise<string | undefined> => {
  const allocatorPublicKey = await getAllocatorPublicKey(
    publicClient,
    allocatorAddress,
    family
  )
  if (family === "ethereum-vm") return computeEvmAddress(allocatorPublicKey)
  if (family === "solana-vm") return computeSolanaAddress(allocatorPublicKey)
  if (family === "bitcoin-vm")
    return computeBitcoinAddressForNetwork(
      allocatorPublicKey,
      bitcoin.networks[network]
    )

  return
}

export const getAllocatorPublicKey = async (
  publicClient: any,
  allocatorAddress: string,
  family: ChainType
) => {
  const { isTestnet } = networks[await publicClient.getChainId()]

  const { rpc: nearRpcUrl } = {
    rpc: "https://rpc.mainnet.near.org",
    // signer: "v1.signer",
  }

  // Get the near signer from the allocator contract
  const nearSigner = (await publicClient.readContract({
    abi: [
      {
        inputs: [],
        name: "nearSigner",
        outputs: [{ name: "", type: "string" }],
        stateMutability: "view",
        type: "function",
      },
    ],
    address: allocatorAddress as `0x${string}`,
    functionName: "nearSigner",
  })) as string
  console.log(
    `Using Near signer on ${isTestnet ? "testnet" : "mainnet"}: ${nearSigner}`
  )
  const derivationPath = allocatorAddress.toLowerCase()
  const predecessor = `${allocatorAddress.substring(2).toLowerCase()}.aurora`

  // Get the public key from the NEAR signer contract
  const { publicKey: allocatorPublicKeyRaw } = await derivePublicKey(
    derivationPath,
    predecessor,
    getDomainId(family),
    nearSigner,
    nearRpcUrl
  )

  return allocatorPublicKeyRaw
}

export const computeEvmAddress = (allocatorPublicKeyRaw: string) => {
  // Decode the base58 public key and convert to Ethereum address format
  const allocatorPublicKey = `0x04${Buffer.from(base58.decode(allocatorPublicKeyRaw)).toString("hex")}`

  // Convert pk to address
  const signerAddress = publicKeyToAddress(allocatorPublicKey as `0x${string}`)
  return signerAddress
}

const computeSolanaAddress = (allocatorPublicKeyRaw: string) => {
  // The base58 decoded public key is the Solana address (Ed25519 format)
  return base58.encode(base58.decode(allocatorPublicKeyRaw))
}

const computeBitcoinAddressForNetwork = (
  allocatorPublicKeyRaw: string,
  network = bitcoin.networks.bitcoin
) => {
  const raw = Buffer.from(base58.decode(allocatorPublicKeyRaw))

  const x = raw.subarray(0, 32)
  const y = raw.subarray(32, 64)
  const yIsEven = (y[31] & 1) === 0
  const prefix = yIsEven ? 0x02 : 0x03
  const pubKeyCompressed = Buffer.concat([
    Buffer.from([prefix]),
    Buffer.from(x),
  ])

  return bitcoin.payments.p2pkh({
    network,
    pubkey: pubKeyCompressed,
  }).address!
}
