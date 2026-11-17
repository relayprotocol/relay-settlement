import type { NetworkConfig } from "../../types"
import { resolveRpc } from "../../rpc"

export const baseSepolia: NetworkConfig = {
  chainId: 84532n,
  contracts: {
    prod: {
      depository: "0x5Feab8dB4534F9F7E2669Bb260c57a01aD1c12e3",
    },
  },
  family: "ethereum-vm",
  hubChainId: "84532",
  isTestnet: true,
  name: "Base Sepolia",
  ...resolveRpc(process.env.RPC_84532, ["https://sepolia.base.org"]),
  slug: "base-sepolia",
}
