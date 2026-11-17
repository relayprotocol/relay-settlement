import { describe, expect, it } from "vitest"
import { immutableAddressAbi } from "../../deployments/scripts/misc/verify-deployment/constants"
import { buildExpectedWiring } from "../../deployments/scripts/misc/verify-deployment/steps"

describe("withdraw fee deployment wiring", () => {
  const wiring = buildExpectedWiring({
    withdrawGasPayer: "0x1111111111111111111111111111111111111111",
  })

  it("ignores historical gas payer records", () => {
    const references = [
      ...wiring.expectedImmutableAddresses.flatMap((entry) => [
        entry.contract,
        entry.expected,
      ]),
      ...wiring.expectedRoles.flatMap((entry) => [
        entry.contract,
        ...entry.holders,
      ]),
    ]
    expect(references).not.toContain("withdrawGasPayer")
  })

  it("does not expect a payer getter on payload builders", () => {
    const builderFields = wiring.expectedImmutableAddresses
      .filter((entry) => entry.contract.endsWith("PayloadBuilder"))
      .map((entry) => entry.field)
    expect(builderFields.length).toBeGreaterThan(0)
    for (const field of builderFields) {
      expect(["ALLOCATOR", "CONFIG"]).toContain(field)
    }
    expect(immutableAddressAbi.map((item) => item.name)).not.toContain(
      "GAS_PAYER"
    )
  })
})
