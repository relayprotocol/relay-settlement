import { resolve } from "path"
import { readdirSync } from "fs"
import { join } from "path"

const txManifestsDir = join(__dirname, "../../transactions")

// Manifests are grouped per deployment env under transactions/<env>/.
export type ManifestEnv = "dev" | "stag" | "prod"

export function getLatestManifestIndex(
  env: ManifestEnv = "prod"
): number | undefined {
  const dirPath = resolve(join(txManifestsDir, env))
  let entries: string[]
  try {
    entries = readdirSync(dirPath)
  } catch {
    return undefined
  }
  const numbers = entries
    .filter((fname) => !fname.startsWith("demo") && /^\d{3}/.test(fname))
    .map((fname) => parseInt(fname.substring(0, 3), 10))
    .filter((n) => !isNaN(n))
  return numbers.length > 0 ? Math.max(...numbers) : undefined
}

export function stringifyJsonWithBigInt(obj: unknown) {
  return JSON.stringify(
    obj,
    (_, value) => (typeof value === "bigint" ? value.toString() : value),
    2
  )
}

export function getManifestPath(
  prefix: string,
  operationNames: string,
  env: ManifestEnv = "prod"
) {
  const numberPrefix = getLatestManifestIndex(env) || 0
  return join(
    txManifestsDir,
    env,
    `${(numberPrefix + 1).toString().padStart(3, "0")}-${prefix}-${operationNames.slice(0, 50)}.json`
  )
}
