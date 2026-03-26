import type { Address } from "viem"

interface EnvironmentConfig {
  solverApiUrl: string
  hubChainId: number
  hubAddress: Address
}

const environments = {
  dev: {
    solverApiUrl: "https://api.dev.relay.link",
    hubChainId: 421614, // Arbitrum Sepolia
    hubAddress: "0xb505c75f4d135c65a9806e2b8ff72b1816be931c" as Address,
  },
  prod: {
    solverApiUrl: "https://api.relay.link",
    hubChainId: 421614, // TODO: update when prod is deployed
    hubAddress: "0x0000000000000000000000000000000000000000" as Address, // TODO
  },
} satisfies Record<string, EnvironmentConfig>

const ENV: keyof typeof environments = "dev"

const config = environments[ENV]

export const SOLVER_API_URL = config.solverApiUrl

export const HUB_CHAIN = {
  id: config.hubChainId,
  relayHubAddress: config.hubAddress,
}
