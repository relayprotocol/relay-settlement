import { Fragment } from "ethers"
import RelayOracleV1 from "./RelayOracle/v1.json"
import RelayOracleV2 from "./RelayOracle/v2.json"
import RelayInbox from "../abis/RelayInbox.sol/RelayInbox.json"

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

// Deployed oracle ABI, replaced by `RelayInbox` once it is deployed
export { RelayOracleV2 }

// Every oracle version, including its successor `RelayInbox` (signed `Execution.expiration`)
export const RelayOracle = mergeVersions(
  RelayOracleV1,
  RelayOracleV2,
  RelayInbox
)
