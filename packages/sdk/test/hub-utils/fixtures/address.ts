import { VirtualAddressComponents } from "../../../src"

export const addressesTestCases: Array<{
  name: string
  input: VirtualAddressComponents
  expectedAddress: `0x${string}`
}> = [
  {
    expectedAddress: "0x251EdF52aBa8E3aEA24d7021dC1c76CC7a857AB7",
    input: {
      address: "0x0000000000000000000000000000000000000000",
      chainId: "ethereum",
      family: "ethereum-vm",
    },
    name: "ETH on Ethereum", // '0x' + 64 hex characters
  },
  {
    expectedAddress: "0xbd486068A01099c7eBa6614f798424d4A51381c1",
    input: {
      address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
      chainId: "bitcoin",
      family: "bitcoin-vm",
    },
    name: "Bitcoin",
  },
  {
    expectedAddress: "0xDcEef346cB004c0cB4Ee7F28d7e282e2d9AA7e40",
    input: {
      address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      chainId: "solana",
      family: "solana-vm",
    },
    name: "USDC on Solana",
  },
  {
    expectedAddress: "0xa290C277E9b2D7269209615d306c15A8cd8D3938",
    input: {
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      chainId: "base",
      family: "ethereum-vm",
    },
    name: "USDC on Base",
  },
  // See the note on the Hedera cases in ./tokenId.ts.
  {
    expectedAddress: "0x3b83171A4db29E5f3e8C7c34D1B056794c566159",
    input: {
      address: "0.0.0",
      chainId: "hedera",
      family: "hedera-vm",
    },
    name: "HBAR on Hedera",
  },
  {
    expectedAddress: "0xfa47eD5C712e8FFF60A4655CFB9A47B57B624564",
    input: {
      address: "0.0.456858",
      chainId: "hedera",
      family: "hedera-vm",
    },
    name: "USDC on Hedera",
  },
]
