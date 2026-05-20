import { resolve } from "path"
import { readdirSync } from "fs"
import { join } from "path"

const txManifestsDir = join(__dirname, "../../transactions")

export function getLatestManifestIndex(): number | undefined {
  const dirPath = resolve(txManifestsDir)
  const files = readdirSync(dirPath).filter(
    (fname) => !fname.startsWith("demo") && /^\d{3}/.test(fname)
  )
  const numbers = files
    .map((fname) => parseInt(fname.substring(0, 3), 10))
    .filter((n) => !isNaN(n))
  return Math.max(...numbers)
}

export function stringifyJsonWithBigInt(obj: unknown) {
  return JSON.stringify(
    obj,
    (_, value) => (typeof value === "bigint" ? value.toString() : value),
    2
  )
}

export function getManifestPath(prefix: string, operationNames: string) {
  const numberPrefix = getLatestManifestIndex() || 0
  return join(
    txManifestsDir,
    `${(numberPrefix + 1).toString().padStart(3, "0")}-${prefix}-${operationNames.slice(0, 50)}.json`
  )
}
