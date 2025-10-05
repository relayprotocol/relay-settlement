import { describe, expect, it } from "vitest"
import { HubClient } from "./client"

const hubClient = new HubClient({
  address: "0x1234567890AbcdEF1234567890aBcdef12345678",
  chainId: "1",
})

describe("client", () => {
  it("should be able to import the client", () => {
    expect(hubClient).toBeDefined()
    expect(hubClient.chainId).toBe("1")
    expect(hubClient.address).toBe("0x1234567890AbcdEF1234567890aBcdef12345678")
  })
})
