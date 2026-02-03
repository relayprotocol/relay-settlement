import { ChainType } from "@relay-settlement/types"
import { task } from "hardhat/config"
import { deriveAllocatorSignerAddress } from "../../lib/signer"
import { networks } from "@relay-protocol/settlement-networks"

const SUPPORTED_FAMILIES: ChainType[] = [
  "bitcoin-vm",
  "ethereum-vm",
  "solana-vm",
  "tron-vm",
  // 'sui-vm',
]

task(
  "allocator:signer-address",
  "Compute allocator signer address from NEAR MPC signer"
)
  .addOptionalParam("allocator", "The address of the allocator contract")
  .addOptionalParam(
    "family",
    `The family address (${SUPPORTED_FAMILIES.join()}). If not provided, shows all families.`
  )
  .addOptionalParam(
    "addressNetwork",
    "The network for which to generate the address. only used for bitcoin-vm."
  )
  .addOptionalParam("env", "The environment (prod or dev)", "prod")
  .setAction(
    async (
      { allocator: allocatorAddress, family, addressNetwork, env },
      { viem, network }
    ) => {
      if (family && !SUPPORTED_FAMILIES.includes(family)) {
        throw Error(`Family "${family}" not supported`)
      }

      // Get allocator address from network config if not provided
      if (!allocatorAddress) {
        const { chainId } = network.config as { chainId: bigint }
        const networkConfig = networks[chainId.toString()]

        if (!networkConfig) {
          throw new Error(`No network config found for chain ID ${chainId}`)
        }

        allocatorAddress = networkConfig.contracts?.[env]?.allocator

        if (!allocatorAddress) {
          throw new Error(
            `No allocator address found in network config for chain ${chainId} (${env})`
          )
        }

        console.log(
          `Using allocator address from network config (${env}): ${allocatorAddress}`
        )
      }

      console.log(
        `Computing MPC signer addresses for allocator: ${allocatorAddress}\n`
      )

      const publicClient = await viem.getPublicClient()

      // If no family specified, show all families
      if (!family) {
        const results: Record<string, string> = {}

        for (const currentFamily of SUPPORTED_FAMILIES) {
          const signerAddress = await deriveAllocatorSignerAddress(
            publicClient,
            allocatorAddress,
            currentFamily,
            addressNetwork
          )
          results[currentFamily] = signerAddress
          console.log(`${currentFamily.padEnd(15)} | ${signerAddress}`)
        }

        return results
      }

      // Single family
      const signerAddress = await deriveAllocatorSignerAddress(
        publicClient,
        allocatorAddress,
        family,
        addressNetwork
      )
      console.log(`${family} signer: ${signerAddress}`)
      return signerAddress
    }
  )
