import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { writeFileSync, unlinkSync, existsSync } from "fs"
import { join } from "path"
import { type OverrideConfig } from "../src/config-loader"
import { initializeNetworks } from "../src/networks-index"

describe("overrides", () => {
  const testOverrideFile = join(__dirname, "test-overrides.json")

  beforeEach(() => {
    if (existsSync(testOverrideFile)) {
      unlinkSync(testOverrideFile)
    }
  })

  afterEach(() => {
    if (existsSync(testOverrideFile)) {
      unlinkSync(testOverrideFile)
    }
  })

  describe("initializeNetworks", () => {
    it("should return networks accessible by slug", () => {
      const networks = initializeNetworks()
      expect(networks.ethereum).toBeDefined()
      expect(networks.ethereum?.slug).toBe("ethereum")
      expect(networks.ethereum?.chainId).toBe(1n)
    })

    it("should return networks accessible by chainId string", () => {
      const networks = initializeNetworks()
      expect(networks["1"]).toBeDefined()
      expect(networks["1"]?.slug).toBe("ethereum")
      expect(networks["1"]?.chainId).toBe(1n)
    })

    it("should return same network for slug and chainId access", () => {
      const networks = initializeNetworks()
      expect(networks.ethereum).toBe(networks["1"])
    })

    it("should apply overrides from file", () => {
      const overrideConfig: OverrideConfig = {
        ethereum: {
          name: "Ethereum Custom",
          rpc: ["https://custom-rpc.example.com"],
        },
      }
      writeFileSync(testOverrideFile, JSON.stringify(overrideConfig, null, 2))

      const networks = initializeNetworks({
        overrideFile: testOverrideFile,
      })

      expect(networks.ethereum?.name).toBe("Ethereum Custom")
      expect(networks.ethereum?.rpc).toEqual(["https://custom-rpc.example.com"])
      expect(networks["1"]?.name).toBe("Ethereum Custom")
    })
  })
})
