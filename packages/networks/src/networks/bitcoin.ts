import { NetworkConfig } from "@relay-settlement/types"

export const bitcoin: NetworkConfig = {
  chainId:
    56960375584792109628315999883526364004747792730920852649053369508622489636429n,
  contracts: {
    prod: {
      depository: "bc1qdqqsq6y7csd0cr3ye45h9lv8ydh777j2wehgl6",
    },
  },
  family: "bitcoin-vm",
  hubChainId:
    "56960375584792109628315999883526364004747792730920852649053369508622489636429",
  isTestnet: false,
  name: "Bitcoin",
  rpc: process.env.RPC_BITCOIN
    ? [process.env.RPC_BITCOIN]
    : ["https://billowing-purple-crater.btc.quiknode.pro"],
  slug: "bitcoin",
}
