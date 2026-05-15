#!/usr/bin/env ts-node
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

type LineHits = Map<number, number>
type BranchHits = Map<string, number>

interface FileCoverage {
  branches: BranchHits
  lines: LineHits
}

type Coverage = Map<string, FileCoverage>

function normalizeSourcePath(sourcePath: string): string {
  const marker = "/contracts/"
  const idx = sourcePath.lastIndexOf(marker)
  if (idx >= 0) return sourcePath.slice(idx + 1)
  return sourcePath
}

function parseLcov(contents: string, into: Coverage): void {
  let currentEntry: FileCoverage | null = null

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    if (line.startsWith("SF:")) {
      const file = normalizeSourcePath(line.slice(3))
      currentEntry = into.get(file) ?? { branches: new Map(), lines: new Map() }
      into.set(file, currentEntry)
      continue
    }

    if (line === "end_of_record") {
      currentEntry = null
      continue
    }

    if (!currentEntry) continue

    if (line.startsWith("DA:")) {
      const [lineNoStr, hitsStr] = line.slice(3).split(",")
      const lineNo = Number(lineNoStr)
      const hits = Number(hitsStr)
      if (Number.isFinite(lineNo) && Number.isFinite(hits)) {
        const prev = currentEntry.lines.get(lineNo) ?? 0
        currentEntry.lines.set(lineNo, Math.max(prev, hits))
      }
      continue
    }

    if (line.startsWith("BRDA:")) {
      const [lineNoStr, blockStr, branchStr, takenStr] = line
        .slice(5)
        .split(",")
      const lineNo = Number(lineNoStr)
      if (!Number.isFinite(lineNo)) continue
      const taken = takenStr === "-" ? 0 : Number(takenStr)
      if (!Number.isFinite(taken)) continue
      const key = `${lineNo}:${blockStr}:${branchStr}`
      const prev = currentEntry.branches.get(key) ?? 0
      currentEntry.branches.set(key, Math.max(prev, taken))
    }
  }
}

function emitLcov(coverage: Coverage): string {
  const out: string[] = []
  for (const [file, entry] of coverage) {
    out.push(`SF:${file}`)

    const lineKeys = [...entry.lines.keys()].sort((a, b) => a - b)
    let linesFound = 0
    let linesHit = 0
    for (const lineNo of lineKeys) {
      const hits = entry.lines.get(lineNo) ?? 0
      out.push(`DA:${lineNo},${hits}`)
      linesFound += 1
      if (hits > 0) linesHit += 1
    }

    const branchKeys = [...entry.branches.keys()].sort()
    let branchesFound = 0
    let branchesHit = 0
    for (const key of branchKeys) {
      const taken = entry.branches.get(key) ?? 0
      const [lineNoStr, blockStr, branchStr] = key.split(":")
      out.push(
        `BRDA:${lineNoStr},${blockStr},${branchStr},${taken === 0 ? "-" : taken}`
      )
      branchesFound += 1
      if (taken > 0) branchesHit += 1
    }

    if (branchesFound > 0) {
      out.push(`BRF:${branchesFound}`)
      out.push(`BRH:${branchesHit}`)
    }
    out.push(`LF:${linesFound}`)
    out.push(`LH:${linesHit}`)
    out.push("end_of_record")
  }
  return out.join("\n") + "\n"
}

function main(): void {
  const args = process.argv.slice(2)
  let outputPath: string | null = null
  const inputs: string[] = []

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === "-o" || arg === "--output") {
      outputPath = args[i + 1]
      i += 1
      continue
    }
    inputs.push(arg)
  }

  if (inputs.length === 0) {
    console.error(
      "usage: merge-lcov [--output <path>] <lcov-1> [<lcov-2> ...]"
    )
    console.error(
      "  Unions per-file line and branch hit counts across multiple lcov files."
    )
    console.error("  If --output is omitted, the merged lcov is written to stdout.")
    process.exit(2)
  }

  const merged: Coverage = new Map()
  for (const input of inputs) {
    const path = resolve(process.cwd(), input)
    if (!existsSync(path)) {
      console.error(`error: lcov input not found at ${path}`)
      process.exit(2)
    }
    parseLcov(readFileSync(path, "utf8"), merged)
  }

  const out = emitLcov(merged)
  if (outputPath) {
    writeFileSync(resolve(process.cwd(), outputPath), out, "utf8")
  } else {
    process.stdout.write(out)
  }
}

main()
