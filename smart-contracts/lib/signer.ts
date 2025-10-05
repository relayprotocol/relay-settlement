import { networks } from "@relay-protocol/networks"
import { ChainType } from "@relay-protocol/types"
import { base58 } from "@scure/base"
import { createHash } from "crypto"
import { publicKeyToAddress } from "viem/accounts"
import { derivePublicKey } from "./near"

// EdDSA for Solana, ECDSA for EVM and Bitcoin
export const getDomainId = (family: ChainType) =>
  family === "solana-vm" ? 1 : 0

export const deriveAllocatorSignerAddress = async (
  publicClient: any,
  allocatorAddress: string,
  family: ChainType
): Promise<string | undefined> => {
  const allocatorPublicKey = await getAllocatorPublicKey(
    publicClient,
    allocatorAddress,
    family
  )
  if (family === "ethereum-vm") return computeEvmAddress(allocatorPublicKey)
  if (family === "solana-vm") return computeSolanaAddress(allocatorPublicKey)
  if (family === "bitcoin-vm") return computeBitcoinAddress(allocatorPublicKey)

  return
}

export const getAllocatorPublicKey = async (
  publicClient: any,
  allocatorAddress: string,
  family: ChainType
) => {
  const { isTestnet, near: nearNetwork } =
    networks[await publicClient.getChainId()]
  const { rpc: nearRpcUrl } = nearNetwork!

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
    `using Near signer on ${isTestnet ? "testnet" : "mainnet"}: ${nearSigner}`
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

const computeEvmAddress = (allocatorPublicKeyRaw: string) => {
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

const computeBitcoinAddress = (allocatorPublicKeyRaw: string) => {
  // For Bitcoin, we need to convert the ECDSA public key to a Bitcoin address
  const publicKeyBytes = Buffer.from(base58.decode(allocatorPublicKeyRaw))

  // Create P2PKH address (Legacy Bitcoin address)
  // 1. Hash the public key with SHA256
  const sha256Hash = createHash("sha256").update(publicKeyBytes).digest()
  // 2. Hash the result with RIPEMD160
  const ripemd160Hash = createHash("ripemd160").update(sha256Hash).digest()
  // 3. Add version byte (0x00 for mainnet)
  const versionedHash = Buffer.concat([Buffer.from([0x00]), ripemd160Hash])
  // 4. Double SHA256 for checksum
  const checksum = createHash("sha256")
    .update(createHash("sha256").update(versionedHash).digest())
    .digest()
    .slice(0, 4)
  // 5. Combine and encode with base58
  const bitcoinAddress = base58.encode(Buffer.concat([versionedHash, checksum]))

  return bitcoinAddress
}
