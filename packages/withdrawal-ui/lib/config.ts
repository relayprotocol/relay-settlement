import { createPublicClient, http, type Address, type Chain } from "viem"

// Next.js inlines NEXT_PUBLIC_* vars at build time only when accessed as
// literal `process.env.NEXT_PUBLIC_X` expressions — dynamic lookups won't work.
export const SOLVER_API_URL = process.env.NEXT_PUBLIC_SOLVER_API_URL!
const hubRpcUrl = process.env.NEXT_PUBLIC_HUB_RPC_URL!
const hubChainId = Number(process.env.NEXT_PUBLIC_HUB_CHAIN_ID!)
const hubAddress = process.env.NEXT_PUBLIC_HUB_ADDRESS! as Address

export const HUB_CHAIN = {
  id: hubChainId,
  rpcUrl: hubRpcUrl,
  relayHubAddress: hubAddress,
  viemChain: {
    id: hubChainId,
    name: "Hub",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [hubRpcUrl] } },
  } satisfies Chain,
}

export const hubClient = createPublicClient({
  chain: HUB_CHAIN.viemChain,
  transport: http(HUB_CHAIN.rpcUrl),
})
