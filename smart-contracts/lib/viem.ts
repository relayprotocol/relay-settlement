import { conduitTestnet, sovereignTestnet } from "@relay-protocol/networks"
import { defineChain } from "viem"
import * as viemChains from "viem/chains"

const conduitTestnetViem = defineChain({
  id: Number(conduitTestnet.chainId),
  name: conduitTestnet.name,
  nativeCurrency: conduitTestnet.nativeCurrency!,
  rpcUrls: {
    default: {
      http: conduitTestnet.rpc,
    },
  },
})

const sovereignTestnetViem = defineChain({
  id: Number(sovereignTestnet.chainId),
  name: sovereignTestnet.name,
  nativeCurrency: sovereignTestnet.nativeCurrency!,
  rpcUrls: {
    default: {
      http: sovereignTestnet.rpc,
    },
  },
})

const customChains = [conduitTestnetViem, sovereignTestnetViem]

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
      const publicClient = hre.viem.getPublicClient({ chain })
      const walletClients = await hre.viem.getWalletClients({
        chain,
      })
      return { publicClient, walletClients }
    }
    // viem will throw if chain is unknwon
    throw Error("Viem unsupported chain. Add to lib/viem.ts")
  } else {
    const publicClient = hre.viem.getPublicClient()
    const walletClients = await hre.viem.getWalletClients()
    return { public: publicClient, walletClients }
  }
}
