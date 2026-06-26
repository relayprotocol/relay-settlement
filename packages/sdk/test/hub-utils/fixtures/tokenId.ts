import { TokenIdComponents } from "../../../src"

export const tokenIdTestCases: Array<{
  name: string
  input: TokenIdComponents
  expectedValue: bigint
}> = [
  {
    expectedValue:
      75768216729734233842356022798368373679005098618301361336704166989654078618295n,
    input: {
      address: "0x0000000000000000000000000000000000000000",
      chainId: "ethereum",
      family: "ethereum-vm",
    },
    name: "ETH on Ethereum",
  },
  {
    expectedValue:
      113774434098830343795219008544843424141910643621990732712082723130350939374017n,
    input: {
      address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
      chainId: "bitcoin",
      family: "bitcoin-vm",
    },
    name: "Bitcoin",
  },
  {
    expectedValue:
      72630457970927688859518598921094794508663362931548696331709346694245435211328n,
    input: {
      address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      chainId: "solana",
      family: "solana-vm",
    },
    name: "USDC on Solana",
  },
  {
    expectedValue:
      86512134522270721992957910457991533944458899231992780260485192288294071515448n,
    input: {
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      chainId: "base",
      family: "ethereum-vm",
    },
    name: "USDC on Base",
  },
]
