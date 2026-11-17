import type { NetworkConfig } from "../types"
import { resolveRpc } from "../rpc"

export const cronos: NetworkConfig = {
  chainId: 25n,
  contracts: {
    prod: { depository: "0x59916DA825D2D2eC1BF878D71c88826F6633ecca" },
    stag: { depository: "0xa4DA4Ec0558404CebBA46Bd112663723BC89829B" },
  },
  family: "ethereum-vm",
  hubChainId: "25",
  isTestnet: false,
  name: "Cronos",
  ...resolveRpc(process.env.RPC_25, ["https://evm.cronos.org"]),
  slug: "cronos",
}
