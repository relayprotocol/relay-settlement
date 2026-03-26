import { createPublicClient, http, type Address } from "viem"

interface EnvironmentConfig {
  solverApiUrl: string
  hubRpcUrl: string
  hubChainId: number
  hubAddress: Address
}

const environments = {
  dev: {
    solverApiUrl: "https://api.dev.relay.link",
    hubRpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
    hubChainId: 421614,
    hubAddress: "0xb505c75f4d135c65a9806e2b8ff72b1816be931c" as Address,
  },
  prod: {
    solverApiUrl: "https://api.relay.link",
    hubRpcUrl: "https://rpc.chain.relay.link/rpc",
    hubChainId: 537713,
    hubAddress: "0xddd361727c22a01eb137880678a20b0beae69318" as Address,
  },
} satisfies Record<string, EnvironmentConfig>

const config = environments[process.env.NEXT_PUBLIC_ENV as "dev" | "prod"]

export const SOLVER_API_URL = config.solverApiUrl

export const HUB_CHAIN = {
  id: config.hubChainId,
  rpcUrl: config.hubRpcUrl,
  relayHubAddress: config.hubAddress,
}

export const hubClient = createPublicClient({
  transport: http(HUB_CHAIN.rpcUrl),
})
