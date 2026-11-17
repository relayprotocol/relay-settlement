import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveRpc } from "../src/rpc"
import { mergeOverrides } from "../src/config-loader"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe("RPC provenance", () => {
  it.each([undefined, ""])(
    "marks defaults when the override is %s",
    (override) => {
      const defaults: [string, ...string[]] = ["https://rpc.example.com"]
      expect(resolveRpc(override, defaults)).toEqual({
        rpc: defaults,
        usesDefaultRpc: true,
      })
    }
  )

  it("marks an explicit URL as an override even when it equals a default", () => {
    const url = "https://rpc.example.com"
    expect(resolveRpc(url, [url])).toEqual({
      rpc: [url],
      usesDefaultRpc: false,
    })
  })

  it("does not mark a missing endpoint as a default RPC", () => {
    expect(resolveRpc(undefined, [""])).toEqual({
      rpc: [""],
      usesDefaultRpc: false,
    })
  })

  it("exposes provenance for every built-in network and its aliases", async () => {
    for (const key of Object.keys(process.env).filter((key) =>
      key.startsWith("RPC_")
    )) {
      vi.stubEnv(key, "")
    }
    const { networks, base } = await import("../src")
    for (const network of Object.values(networks)) {
      expect(network.usesDefaultRpc).toBe(
        network.rpc.some((url) => Boolean(url.trim()))
      )
      expect(networks[network.slug]).toBe(networks[network.chainId.toString()])
    }
    expect(base.usesDefaultRpc).toBe(true)
  })

  it.each([
    ["base", "RPC_8453"],
    ["relay", "RPC_RELAY_CHAIN"],
    ["solana", "RPC_SOLANA"],
    ["bitcoin", "RPC_BITCOIN"],
    ["tron", "RPC_TRON"],
    ["eclipse", "RPC_ECLIPSE"],
    ["hyperliquid", "RPC_HYPERLIQUID"],
    ["base-sepolia", "RPC_84532"],
    ["arc", "RPC_5042"],
  ])("tracks environment overrides for %s", async (slug, envName) => {
    vi.stubEnv(envName, "https://configured-rpc.example.com")
    const { networks } = await import("../src")
    expect(networks[slug]?.rpc).toEqual(["https://configured-rpc.example.com"])
    expect(networks[slug]?.usesDefaultRpc).toBe(false)
  })

  it("retains provenance for metadata changes and clears it for RPC overrides", async () => {
    vi.stubEnv("RPC_8453", "")
    const { base } = await import("../src")
    expect(mergeOverrides(base, { name: "Custom Base" }).usesDefaultRpc).toBe(
      true
    )
    expect(mergeOverrides(base, { rpc: base.rpc }).usesDefaultRpc).toBe(false)
    expect(mergeOverrides(base, { rpc: [""] }).usesDefaultRpc).toBe(false)
    expect(base.usesDefaultRpc).toBe(true)
  })
})
