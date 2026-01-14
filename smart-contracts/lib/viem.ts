import {
  calderaTestnet,
  conduitTestnet,
  sovereignTestnet,
} from "@relay-protocol/settlement-networks"
import { defineChain } from "viem"
import * as viemChains from "viem/chains"

const customChains = [conduitTestnet, calderaTestnet, sovereignTestnet].map(
  (chain) =>
    defineChain({
      id: Number(chain.chainId),
      name: chain.name,
      nativeCurrency: chain.nativeCurrency!,
      rpcUrls: {
        default: {
          http: chain.rpc,
        },
      },
    })
)

const isCustomChain = (chainId: bigint) => {
  const viemSupportedChainIds = Object.values(viemChains).map(({ id }) =>
    id.toString()
  )
  return !viemSupportedChainIds.includes(chainId.toString())
}

const getCustomChain = (chainId: bigint) => {
  const chain = customChains.find(
    ({ id }) => id.toString() === chainId.toString()
  )
  return chain
}

export const getViemClients = async (hre: any) => {
  const { chainId } = hre.network.config as { chainId: bigint }
  if (isCustomChain(chainId)) {
    const chain = getCustomChain(chainId)
    if (chain) {
      const publicClient = await hre.viem.getPublicClient({ chain })
      const walletClients = await hre.viem.getWalletClients({
        chain,
      })
      return { publicClient, walletClients }
    }
    // viem will throw if chain is unknwon
    throw Error("Viem unsupported chain. Add to lib/viem.ts")
  } else {
    const publicClient = await hre.viem.getPublicClient()
    const walletClients = await hre.viem.getWalletClients()
    return { publicClient, walletClients }
  }
}
