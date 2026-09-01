import { describe, expect, test } from "vitest"
import { generateAddress } from "../../src/hub/hub-utils"
import { addressesTestCases } from "./fixtures/address"
import { ethers } from "ethers"

describe("Virtual Addresses", () => {
  test.each(addressesTestCases)("$name", ({ input, expectedAddress }) => {
    const address = generateAddress(input)

    const differentInput = {
      ...input,
      chainId: input.chainId + 1n,
    }
    const differentAddress = generateAddress(differentInput)
    expect(address).not.toBe(differentAddress)
    expect(address).toBe(expectedAddress)

    // address with correct checksum
    expect(ethers.getAddress(expectedAddress)).toBe(expectedAddress)
  })

  test("rejects the oversized-address collision (SEC-165)", () => {
    const victim = "0x1111111111111111111111111111111111111111"
    const spoof = "0x30" + victim.slice(2)

    const legit = generateAddress({
      family: "ethereum-vm",
      chainId: "10",
      address: victim,
    })

    expect(() =>
      generateAddress({ family: "ethereum-vm", chainId: "1", address: spoof })
    ).toThrow(/ethereum-vm address byte length 21/)

    expect(ethers.getAddress(legit)).toBe(legit)
  })

  test("enforces hyperliquid-vm account length of 20 bytes (SEC-165)", () => {
    expect(() =>
      generateAddress({
        family: "hyperliquid-vm",
        chainId: "1337",
        address: "0x" + "11".repeat(20),
      })
    ).not.toThrow()

    expect(() =>
      generateAddress({
        family: "hyperliquid-vm",
        chainId: "1337",
        address: "0x" + "00".repeat(16),
      })
    ).toThrow(/hyperliquid-vm byte length 16; expected 20/)
  })
})
