import { Interface } from "ethers"
import { describe, expect, it } from "vitest"

import { RelayInbox, RelayOracle, RelayOracleV2 } from "../src/index"
import deployedOracle from "../src/versions/RelayOracle/v2.json"

// Deployed RelayOracleV2 build: `Execution(bytes32 idempotencyKey,bytes[] actions)`
const DEPLOYED_EXECUTE = "execute((bytes32,bytes[]),address,bytes)"
const DEPLOYED_EXECUTE_MULTIPLE =
  "executeMultiple((bytes32,bytes[])[],address,bytes[])"
const DEPLOYED_SELECTORS = {
  execute: "0x32acd8f9",
  executeMultiple: "0x564df171",
}

// RelayInbox source: `Execution` carries the signed `expiration`
const SOURCE_EXECUTE = "execute((bytes32,bytes[],uint256),address,bytes)"
const SOURCE_EXECUTE_MULTIPLE =
  "executeMultiple((bytes32,bytes[],uint256)[],address,bytes[])"
const SOURCE_SELECTORS = {
  execute: "0xf296a811",
  executeMultiple: "0x3d7e69fa",
}

const selectors = (abi: ReadonlyArray<unknown>) => {
  const sighashes: Record<string, string> = {}
  new Interface(abi as never).forEachFunction((fragment) => {
    sighashes[fragment.format("sighash")] = fragment.selector
  })
  return sighashes
}

describe("RelayOracleV2 export", () => {
  it("is the deployed ABI until the oracle is redeployed", () => {
    expect(RelayOracleV2).toEqual(deployedOracle)
  })

  it("encodes the deployed execute selectors", () => {
    const sighashes = selectors(RelayOracleV2)
    expect(sighashes[DEPLOYED_EXECUTE]).toBe(DEPLOYED_SELECTORS.execute)
    expect(sighashes[DEPLOYED_EXECUTE_MULTIPLE]).toBe(
      DEPLOYED_SELECTORS.executeMultiple
    )
    expect(sighashes[SOURCE_EXECUTE]).toBeUndefined()
    expect(sighashes[SOURCE_EXECUTE_MULTIPLE]).toBeUndefined()
  })
})

describe("RelayInbox export", () => {
  it("encodes the execute selectors with the signed expiration", () => {
    const sighashes = selectors(RelayInbox)
    expect(sighashes[SOURCE_EXECUTE]).toBe(SOURCE_SELECTORS.execute)
    expect(sighashes[SOURCE_EXECUTE_MULTIPLE]).toBe(
      SOURCE_SELECTORS.executeMultiple
    )
    expect(sighashes[DEPLOYED_EXECUTE]).toBeUndefined()
    expect(sighashes[DEPLOYED_EXECUTE_MULTIPLE]).toBeUndefined()
  })

  it("declares the ExecutionExpired error", () => {
    const errors = RelayInbox.filter((item) => item.type === "error")
    expect(errors.map((item) => item.name)).toContain("ExecutionExpired")
  })
})

describe("RelayOracle merged export", () => {
  it("decodes both the deployed and the source execute selectors", () => {
    const sighashes = selectors(RelayOracle)
    expect(sighashes[DEPLOYED_EXECUTE]).toBe(DEPLOYED_SELECTORS.execute)
    expect(sighashes[DEPLOYED_EXECUTE_MULTIPLE]).toBe(
      DEPLOYED_SELECTORS.executeMultiple
    )
    expect(sighashes[SOURCE_EXECUTE]).toBe(SOURCE_SELECTORS.execute)
    expect(sighashes[SOURCE_EXECUTE_MULTIPLE]).toBe(
      SOURCE_SELECTORS.executeMultiple
    )
  })

  it("parses calldata encoded with either execute ABI", () => {
    const key = `0x${"11".repeat(32)}`
    const oracle = `0x${"22".repeat(20)}`
    const deployedData = new Interface(RelayOracleV2).encodeFunctionData(
      DEPLOYED_EXECUTE,
      [[key, ["0x1234"]], oracle, "0xabcd"]
    )
    const sourceData = new Interface(RelayInbox).encodeFunctionData(
      SOURCE_EXECUTE,
      [[key, ["0x1234"], 1_700_000_000n], oracle, "0xabcd"]
    )

    const merged = new Interface(RelayOracle)
    const deployed = merged.parseTransaction({ data: deployedData })
    const source = merged.parseTransaction({ data: sourceData })

    expect(deployed?.selector).toBe(DEPLOYED_SELECTORS.execute)
    expect(deployed?.args[0].idempotencyKey).toBe(key)
    expect(source?.selector).toBe(SOURCE_SELECTORS.execute)
    expect(source?.args[0].expiration).toBe(1_700_000_000n)
  })
})
