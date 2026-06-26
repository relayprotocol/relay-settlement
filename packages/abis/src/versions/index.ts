import { Fragment } from "ethers"
import RelayOracleV1 from "./RelayOracle/v1.json"
import RelayOracleV2 from "./RelayOracle/v2.json"

const mergeVersions = (...abis: Array<Array<Record<string, unknown>>>) => {
  const merged: Array<Record<string, unknown>> = []

  for (const abi of abis) {
    for (const item of abi) {
      const fragment = Fragment.from(item)
      if (fragment.type === "constructor") {
        continue
      }

      const exists = merged.some(
        (existing) => fragment.format() === Fragment.from(existing).format()
      )
      if (!exists) {
        merged.push(item)
      }
    }
  }

  return merged
}

export const RelayOracle = mergeVersions(RelayOracleV1, RelayOracleV2)
