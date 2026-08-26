import { describe, expect, it } from "vitest"

import {
  DepositAddressTrigger,
  getDepositAddressTriggerHash,
} from "../src/messages/v2.3/deposit-address"

const trigger: DepositAddressTrigger = {
  input: {
    vmType: "ethereum-vm",
    chainId: "10",
    currency: "0x0000000000000000000000000000000000000000",
    amount: "1000000",
  },
  derivationFields: {
    inputVmType: "ethereum-vm",
    outputVmType: "ethereum-vm",
    outputChainId: "1",
    outputCurrency: "0x0000000000000000000000000000000000000000",
    outputRecipient: "0x0000000000000000000000000000000000000001",
    solver: "0x0000000000000000000000000000000000000002",
    pricingOracle: "0x0000000000000000000000000000000000000003",
    depositor: "0x0000000000000000000000000000000000000004",
    refundRecipient: "0x0000000000000000000000000000000000000005",
    priceImpactBps: "200",
    salt: "123",
  },
  orderId: `0x${"11".repeat(32)}`,
  nonce: "1",
  currencies: [],
  prices: [],
  extraData: "0x",
}

describe("deposit address trigger hash", () => {
  it("binds the derivation salt", () => {
    const firstHash = getDepositAddressTriggerHash(trigger)
    const secondHash = getDepositAddressTriggerHash({
      ...trigger,
      derivationFields: {
        ...trigger.derivationFields,
        salt: "124",
      },
    })

    expect(secondHash).not.toBe(firstHash)
  })

  it("binds the price publish time", () => {
    const pricedTrigger: DepositAddressTrigger = {
      ...trigger,
      prices: [
        {
          usdPrice: "100000000",
          usdPriceDecimals: 8,
          currencyDecimals: 18,
          publishTime: "1735689500",
          expiration: "1735689600",
        },
      ],
    }
    const firstHash = getDepositAddressTriggerHash(pricedTrigger)
    const secondHash = getDepositAddressTriggerHash({
      ...pricedTrigger,
      prices: [
        {
          ...pricedTrigger.prices[0],
          publishTime: "1735689501",
        },
      ],
    })

    expect(secondHash).not.toBe(firstHash)
  })
})
