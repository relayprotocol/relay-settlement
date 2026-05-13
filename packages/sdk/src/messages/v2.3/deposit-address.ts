import { Address, Hex, encodeAbiParameters, keccak256 } from "viem"

export interface DepositAddressTriggerInput {
  vmType: string
  chainId: string
  currency: string
  amount: string
}

export interface DepositAddressTriggerDerivationFields {
  inputVmType: string
  outputVmType: string
  outputChainId: string
  outputCurrency: string
  outputRecipient: string
  solver: string
  pricingOracle: string
  depositor: string
  refundRecipient: string
  slippageBps: string
}

export interface DepositAddressTriggerCurrency {
  chainId: string
  currency: string
}

export interface DepositAddressTriggerPrice {
  amount: string
  decimals: number
  expiration: string
}

export interface DepositAddressTrigger {
  input: DepositAddressTriggerInput
  derivationFields: DepositAddressTriggerDerivationFields
  orderId: string
  nonce: string
  currencies: DepositAddressTriggerCurrency[]
  prices: DepositAddressTriggerPrice[]
  extraData: string
}

const TRIGGER_HASH_ABI = [
  {
    components: [
      { name: "vmType", type: "string" },
      { name: "chainId", type: "string" },
      { name: "currency", type: "bytes" },
      { name: "amount", type: "uint256" },
    ],
    type: "tuple",
  },
  {
    components: [
      { name: "inputVmType", type: "string" },
      { name: "outputVmType", type: "string" },
      { name: "outputChainId", type: "string" },
      { name: "outputCurrency", type: "bytes" },
      { name: "outputRecipient", type: "bytes" },
      { name: "solver", type: "address" },
      { name: "pricingOracle", type: "address" },
      { name: "depositor", type: "bytes" },
      { name: "refundRecipient", type: "bytes" },
      { name: "slippageBps", type: "uint256" },
    ],
    type: "tuple",
  },
  { type: "bytes32" },
  { type: "uint256" },
  {
    components: [
      { name: "chainId", type: "string" },
      { name: "currency", type: "bytes" },
    ],
    type: "tuple[]",
  },
  {
    components: [
      { name: "amount", type: "uint256" },
      { name: "decimals", type: "uint8" },
      { name: "expiration", type: "uint256" },
    ],
    type: "tuple[]",
  },
  { type: "bytes" },
] as const

export const getDepositAddressTriggerHash = (
  trigger: DepositAddressTrigger
) => {
  const encoded = encodeAbiParameters(TRIGGER_HASH_ABI, [
    {
      vmType: trigger.input.vmType,
      chainId: trigger.input.chainId,
      currency: trigger.input.currency as Hex,
      amount: BigInt(trigger.input.amount),
    },
    {
      inputVmType: trigger.derivationFields.inputVmType,
      outputVmType: trigger.derivationFields.outputVmType,
      outputChainId: trigger.derivationFields.outputChainId,
      outputCurrency: trigger.derivationFields.outputCurrency as Hex,
      outputRecipient: trigger.derivationFields.outputRecipient as Hex,
      solver: trigger.derivationFields.solver as Address,
      pricingOracle: trigger.derivationFields.pricingOracle as Address,
      depositor: trigger.derivationFields.depositor as Hex,
      refundRecipient: trigger.derivationFields.refundRecipient as Hex,
      slippageBps: BigInt(trigger.derivationFields.slippageBps),
    },
    trigger.orderId as Hex,
    BigInt(trigger.nonce),
    trigger.currencies.map((currency) => ({
      chainId: currency.chainId,
      currency: currency.currency as Hex,
    })),
    trigger.prices.map((price) => ({
      amount: BigInt(price.amount),
      decimals: price.decimals,
      expiration: BigInt(price.expiration),
    })),
    trigger.extraData as Hex,
  ])

  return keccak256(encoded)
}
