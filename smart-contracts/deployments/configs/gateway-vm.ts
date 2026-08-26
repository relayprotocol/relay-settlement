import type { Address } from "viem"

export type GatewayChainConfig = {
  name: string
  envSuffix: string
  domain: number
  chainId: string
  usdc: Address
  gasFeeUsdc: string
}

export const GATEWAY_CHAINS = [
  {
    chainId: "ethereum",
    domain: 0,
    envSuffix: "ETHEREUM",
    gasFeeUsdc: "1.00",
    name: "ethereum",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  {
    chainId: "avalanche",
    domain: 1,
    envSuffix: "AVALANCHE",
    gasFeeUsdc: "0.02",
    name: "avalanche",
    usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
  },
  {
    chainId: "optimism",
    domain: 2,
    envSuffix: "OPTIMISM",
    gasFeeUsdc: "0.0015",
    name: "optimism",
    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  },
  {
    chainId: "arbitrum",
    domain: 3,
    envSuffix: "ARBITRUM",
    gasFeeUsdc: "0.01",
    name: "arbitrum",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  },
  {
    chainId: "base",
    domain: 6,
    envSuffix: "BASE",
    gasFeeUsdc: "0.01",
    name: "base",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  {
    chainId: "polygon",
    domain: 7,
    envSuffix: "POLYGON",
    gasFeeUsdc: "0.0015",
    name: "polygon",
    usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  },
  {
    chainId: "unichain",
    domain: 10,
    envSuffix: "UNICHAIN",
    gasFeeUsdc: "0.001",
    name: "unichain",
    usdc: "0x078D782b760474a361dDA0AF3839290b0EF57AD6",
  },
  {
    chainId: "sonic",
    domain: 13,
    envSuffix: "SONIC",
    gasFeeUsdc: "0.01",
    name: "sonic",
    usdc: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894",
  },
  {
    chainId: "worldchain",
    domain: 14,
    envSuffix: "WORLDCHAIN",
    gasFeeUsdc: "0.01",
    name: "worldchain",
    usdc: "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1",
  },
  {
    chainId: "sei",
    domain: 16,
    envSuffix: "SEI",
    gasFeeUsdc: "0.001",
    name: "sei",
    usdc: "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392",
  },
  {
    chainId: "hyperevm",
    domain: 19,
    envSuffix: "HYPEREVM",
    gasFeeUsdc: "0.05",
    name: "hyperevm",
    usdc: "0xb88339CB7199b77E23DB6E890353E22632Ba630f",
  },
] as const satisfies readonly GatewayChainConfig[]

export type GatewayChainName = (typeof GATEWAY_CHAINS)[number]["name"]
