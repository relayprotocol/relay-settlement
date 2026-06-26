import { networks } from "@relay-protocol/settlement-networks"
import type { VmType } from "@relay-protocol/settlement-sdk"
import { base58 } from "@scure/base"
import { publicKeyToAddress } from "viem/accounts"
import * as bitcoin from "bitcoinjs-lib"
import * as tronweb from "tronweb"
import { derivePublicKey } from "./near"

// EdDSA for Solana, ECDSA for EVM and Bitcoin
export const getDomainId = (family: VmType) => (family === "solana-vm" ? 1 : 0)

export const deriveAllocatorSignerAddress = async (
  publicClient: any,
  allocatorAddress: string,
  family: VmType,
  network: string = "bitcoin"
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
      bitcoin.networks[network as keyof typeof bitcoin.networks]
    )
  if (family === "tron-vm") return computeTronAddress(allocatorPublicKey)

  return
}

export const getAllocatorPublicKey = async (
  publicClient: any,
  allocatorAddress: string,
  family: VmType
) => {
  const { isTestnet, near } = networks[await publicClient.getChainId()]

  const { rpc: nearRpcUrl } = {
    rpc: near?.rpc ?? "https://free.rpc.fastnear.com",
  }

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
  const allocatorPublicKey = `0x04${Buffer.from(base58.decode(allocatorPublicKeyRaw)).toString("hex")}`
  return publicKeyToAddress(allocatorPublicKey as `0x${string}`)
}

const computeSolanaAddress = (allocatorPublicKeyRaw: string) => {
  return base58.encode(base58.decode(allocatorPublicKeyRaw))
}

const computeTronAddress = (allocatorPublicKeyRaw: string) => {
  const evmAddress = computeEvmAddress(allocatorPublicKeyRaw)
  const addressHex = evmAddress.slice(-40)
  const tronAddressHex = `41${addressHex}`
  return tronweb.TronWeb.address.fromHex(tronAddressHex)
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
