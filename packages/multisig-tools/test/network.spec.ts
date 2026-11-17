import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { aurora } from "../../networks/src/networks/aurora"

vi.mock("@relay-protocol/settlement-networks", async () => {
  const { aurora } = await import("../../networks/src/networks/aurora")
  return { networks: { aurora } }
})

vi.mock("viem/accounts", () => ({
  privateKeyToAccount: () => ({
    address: "0x0000000000000000000000000000000000000001",
    type: "json-rpc",
  }),
}))

import { assertEnvOrSigner, resolveNetwork } from "../src/helpers/network"

describe("multisig signer environment resolution", () => {
  beforeEach(() => {
    for (const key of [
      "RELAY_MULTISIG_SIGNER",
      "RPC_URL",
      "CHAIN_ID",
      "MULTISIG_NETWORK",
      "NETWORK",
      "PRIVATE_KEY",
    ]) {
      vi.stubEnv(key, undefined)
    }
    // Account construction is mocked; this is not a signing key.
    vi.stubEnv("DEPLOYER_PRIVATE_KEY", "unused-test-value")
    vi.spyOn(console, "log").mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it("resolves deployers to the verified Aurora signer", () => {
    const result = resolveNetwork({ env: "deployers", network: "aurora" })
    expect(result.multisigSignerAddress).toBe(
      "0xE5Ee6a6E8D57d1D315D1898c68eA1bc487B6EA92"
    )
    expect(result.chainId).toBe(1313161554)
  })

  it.each(["dev", "stag", "test", "prod"] as const)(
    "preserves the %s signer",
    (env) => {
      expect(
        resolveNetwork({ env, network: "aurora" }).multisigSignerAddress
      ).toBe(aurora.contracts?.[env]?.multisigSigner)
    }
  )

  it("does not fall back to dev if the deployers signer is missing", () => {
    const spy = vi.spyOn(aurora, "contracts", "get")
    spy.mockReturnValue({
      dev: { multisigSigner: "0x0000000000000000000000000000000000000001" },
    })
    expect(() =>
      resolveNetwork({ env: "deployers", network: "aurora" })
    ).toThrow("no multisigSigner address")
  })

  it("honors a signer override with deployers", () => {
    const override = "0x0000000000000000000000000000000000000001"
    expect(
      resolveNetwork({
        env: "deployers",
        multisigSignerOverride: override,
        network: "aurora",
      }).multisigSignerAddress
    ).toBe(override)
  })

  it("still requires an explicit environment or signer at the CLI boundary", () => {
    expect(() => assertEnvOrSigner({})).toThrow("deployers")
    expect(() => assertEnvOrSigner({ env: "deployers" })).not.toThrow()
  })
})
