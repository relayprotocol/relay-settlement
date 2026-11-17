import { describe, expect, it } from "vitest"

import {
  isFrozenEntry,
  mixedVersionConfig,
  resolveFrozenVersion,
  type Registry,
} from "./registry"

const published: Registry = {
  prod: {
    versions: {
      v1: { config: { name: "prod" }, code: { "ethereum-vm": "code-eth" } },
    },
  },
}

describe("registry helpers", () => {
  it("distinguishes frozen entries from built entries", () => {
    expect(
      isFrozenEntry({
        env: "prod",
        version: "v1",
        from: { publishedPackage: "0.0.32" },
      })
    ).toBe(true)
    expect(isFrozenEntry({ env: "prod", version: "v2", vms: [] })).toBe(false)
  })

  it("copies a frozen version from the published registry", () => {
    const resolved = resolveFrozenVersion("allocatorEnvs", published, {
      env: "prod",
      version: "v1",
      from: { publishedPackage: "0.0.32" },
    })
    expect(resolved).toEqual(published.prod.versions.v1)
  })

  it("fails when the published package is unavailable", () => {
    expect(() =>
      resolveFrozenVersion("allocatorEnvs", undefined, {
        env: "prod",
        version: "v1",
        from: { publishedPackage: "0.0.32" },
      })
    ).toThrow(
      "allocatorEnvs: cannot freeze prod/v1: @0.0.32 has no allocatorEnvs registry"
    )
  })

  it("selects frozen VMs without retaining a VM that will be rebuilt", () => {
    const source: Registry = {
      dev: {
        versions: {
          "v1.2": {
            config: { name: "dev" },
            code: { "ethereum-vm": "published-eth", "xrp-vm": "old-xrp" },
          },
        },
      },
    }
    const resolved = resolveFrozenVersion("depositAddressEnvs", source, {
      env: "dev",
      version: "v1.2",
      from: { publishedPackage: "0.0.44", vmTypes: ["ethereum-vm"] },
      vms: [{ vmType: "xrp-vm", distBasename: "xrp-vm" }],
    })
    expect(resolved).toEqual({
      config: { name: "dev" },
      code: { "ethereum-vm": "published-eth" },
    })
    expect(source.dev.versions["v1.2"].code["xrp-vm"]).toBe("old-xrp")
  })

  it("fails rather than silently omitting a requested frozen VM", () => {
    expect(() =>
      resolveFrozenVersion("allocatorEnvs", published, {
        env: "prod",
        version: "v1",
        from: { publishedPackage: "0.0.32", vmTypes: ["xrp-vm"] },
      })
    ).toThrow(
      "allocatorEnvs: cannot freeze prod/v1/xrp-vm: not present in @0.0.32"
    )
  })

  it("fails when the published package lacks the env or version", () => {
    const frozen = { from: { publishedPackage: "0.0.32" } }
    expect(() =>
      resolveFrozenVersion("allocatorEnvs", published, {
        env: "dev",
        version: "v1",
        ...frozen,
      })
    ).toThrow("allocatorEnvs: cannot freeze dev/v1: not present in @0.0.32")
    expect(() =>
      resolveFrozenVersion("allocatorEnvs", published, {
        env: "prod",
        version: "v3",
        ...frozen,
      })
    ).toThrow("allocatorEnvs: cannot freeze prod/v3: not present in @0.0.32")
  })

  it("takes only the built VMs' own config fields from the environment", () => {
    const frozenConfig = {
      allocatorAddress: "0xfrozen",
      atlasDomain: { chainId: 21337 },
    }
    const environment = {
      allocatorAddress: "0xlive",
      atlasDomain: { chainId: 43003 },
    }
    const atlas = {
      vmType: "atlas-vm",
      distBasename: "atlas",
      configKeys: ["atlasDomain"],
    }

    expect(mixedVersionConfig(frozenConfig, environment, [atlas])).toEqual({
      allocatorAddress: "0xfrozen",
      atlasDomain: { chainId: 43003 },
    })
    expect(
      mixedVersionConfig(frozenConfig, environment, [
        { vmType: "xrp-vm", distBasename: "xrp" },
      ])
    ).toEqual(frozenConfig)
    expect(
      mixedVersionConfig(frozenConfig, { allocatorAddress: "0xlive" }, [atlas])
    ).toEqual({ allocatorAddress: "0xfrozen" })
  })
})
