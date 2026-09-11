import { describe, it, expect } from "vitest"

import { getOrderAddress, OrderAddressParams } from "../src"

describe("getOrderAddress", () => {
  it("should derive an order address from the chain and deposit ID", () => {
    const params: OrderAddressParams = {
      chainId: "ethereum",
      depositId:
        "0x9400f1b21cb527d7fa3d3eabba93557a18ebe7a2ca4e471cfe5e4c5b4ca7f767",
    }
    const address = getOrderAddress(params)

    expect(address).toBe("0xf85a144b09258a2059b514360936b633e941b685")
  })
})
