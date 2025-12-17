import { NetworkConfig } from "@relay-protocol/types"

export const gunz: NetworkConfig = {
  chainId: 43419n,
  contracts: {
    prod: { depository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31" },
  },
  family: "ethereum-vm",
  hubChainId: "43419",
  isTestnet: false,
  name: "Gunz",
  rpc: process.env.RPC_43419
    ? [process.env.RPC_43419]
    : [
        "https://rpc.gunzchain.io/ext/bc/2M47TxWHGnhNtq6pM5zPXdATBtuqubxn5EPFgFmEawCQr9WFML/rpc",
      ],
  slug: "gunz",
}
