// ABOUTME: viem helpers for producing SignedPrice attestations for SignedPricingOracle.
// ABOUTME: Mirrors the EIP-712 typed-data layout enforced by the contract.
import { Hex, WalletClient, encodeAbiParameters } from "viem"

export interface SignedPriceInput {
  chainId: string
  currency: Hex
  usdPrice: bigint
  usdPriceDecimals: number
  currencyDecimals: number
  expiration: bigint
}

export interface SignedPrice extends SignedPriceInput {
  signature: Hex
}

export const SIGNED_PRICE_ARRAY_ABI = [
  {
    components: [
      { name: "chainId", type: "string" },
      { name: "currency", type: "bytes" },
      { name: "usdPrice", type: "uint256" },
      { name: "usdPriceDecimals", type: "uint8" },
      { name: "currencyDecimals", type: "uint8" },
      { name: "expiration", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    type: "tuple[]",
  },
] as const

export const signPrice = async (
  signer: WalletClient,
  verifyingContract: Hex,
  input: SignedPriceInput
): Promise<SignedPrice> => {
  const chainId = await signer.getChainId()
  const signature = await signer.signTypedData({
    account: signer.account!,
    domain: {
      chainId,
      name: "SignedPricingOracle",
      verifyingContract,
      version: "1",
    },
    message: {
      chainId: input.chainId,
      currency: input.currency,
      currencyDecimals: input.currencyDecimals,
      expiration: input.expiration,
      usdPrice: input.usdPrice,
      usdPriceDecimals: input.usdPriceDecimals,
    },
    primaryType: "SignedPrice",
    types: {
      SignedPrice: [
        { name: "chainId", type: "string" },
        { name: "currency", type: "bytes" },
        { name: "usdPrice", type: "uint256" },
        { name: "usdPriceDecimals", type: "uint8" },
        { name: "currencyDecimals", type: "uint8" },
        { name: "expiration", type: "uint256" },
      ],
    },
  })
  return { ...input, signature }
}

export const encodeSignedPrices = (signed: SignedPrice[]): Hex =>
  encodeAbiParameters(SIGNED_PRICE_ARRAY_ABI, [signed])
