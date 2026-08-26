#!/usr/bin/env ts-node

import fs from "node:fs"
import path from "node:path"

type CoverageKind = "lines" | "functions" | "branches"

interface CoverageCount {
  found: number
  hit: number
}

interface Thresholds {
  lines: number
  functions: number
  branches: number
}

const WORKSPACE_ROOT = path.resolve(__dirname, "..")
const DEFAULT_REPORT = path.join(WORKSPACE_ROOT, "out", "lcov.info")
const THRESHOLDS_FILE = path.join(__dirname, "coverage-thresholds.json")

const reportPath = path.resolve(process.argv[2] ?? DEFAULT_REPORT)
const thresholds = JSON.parse(
  fs.readFileSync(THRESHOLDS_FILE, "utf8")
) as Thresholds

const counts: Record<CoverageKind, CoverageCount> = {
  branches: { found: 0, hit: 0 },
  functions: { found: 0, hit: 0 },
  lines: { found: 0, hit: 0 },
}

const productionSource = /^contracts\/(?!mocks\/|test-utils\/).+\.sol$/
const sources = new Set<string>()
let currentSource: string | null = null

const add = (kind: CoverageKind, field: "found" | "hit", value: string) => {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid LCOV value: ${value}`)
  }
  counts[kind][field] += parsed
}

for (const line of fs.readFileSync(reportPath, "utf8").split(/\r?\n/)) {
  const separator = line.indexOf(":")
  if (separator === -1) continue

  const field = line.slice(0, separator)
  const value = line.slice(separator + 1)

  if (field === "SF") {
    currentSource = value
    if (!productionSource.test(value)) {
      throw new Error(
        `Non-production source found in coverage report: ${value}`
      )
    }
    sources.add(value)
    continue
  }

  if (!currentSource) continue

  if (field === "LF") add("lines", "found", value)
  if (field === "LH") add("lines", "hit", value)
  if (field === "FNF") add("functions", "found", value)
  if (field === "FNH") add("functions", "hit", value)
  if (field === "BRF") add("branches", "found", value)
  if (field === "BRH") add("branches", "hit", value)
}

if (sources.size === 0) {
  throw new Error(`No production Solidity sources found in ${reportPath}`)
}

let failed = false

console.log(`Production Solidity coverage (${sources.size} source files)`)

for (const kind of ["lines", "functions", "branches"] as const) {
  const { found, hit } = counts[kind]
  if (found === 0) {
    throw new Error(`LCOV report contains no ${kind}`)
  }

  const percentage = (hit / found) * 100
  const threshold = thresholds[kind]
  const passed = percentage >= threshold
  failed ||= !passed

  console.log(
    `${kind.padEnd(9)} ${percentage.toFixed(2)}% (${hit}/${found}), minimum ${threshold.toFixed(2)}% ${passed ? "PASS" : "FAIL"}`
  )
}

if (failed) {
  process.exitCode = 1
}
