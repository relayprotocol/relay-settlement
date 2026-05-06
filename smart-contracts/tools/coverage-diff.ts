#!/usr/bin/env ts-node
import { execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

type LineHits = Map<number, number>
type BranchHits = Map<string, number>

interface FileCoverage {
  branches: BranchHits
  lines: LineHits
}

type Coverage = Map<string, FileCoverage>

interface LineRegression {
  baselineHits: number
  currentHits: number
  file: string
  line: number
}

interface BranchRegression {
  baselineTaken: number
  branchKey: string
  currentTaken: number
  file: string
  line: number
}

const REFRESH_TAG = "[baseline:refresh]"

// solidity-coverage emits absolute SF: paths that include the runner's working
// directory, so a baseline generated on one machine and a current run executed
// on another will never share path keys. Normalize to the canonical
// "contracts/..." prefix so comparisons are environment-independent.
function normalizeSourcePath(sourcePath: string): string {
  const marker = "/contracts/"
  const idx = sourcePath.lastIndexOf(marker)
  if (idx >= 0) return sourcePath.slice(idx + 1)
  return sourcePath
}

function parseLcov(contents: string): Coverage {
  const coverage: Coverage = new Map()
  let currentEntry: FileCoverage | null = null

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    if (line.startsWith("SF:")) {
      const file = normalizeSourcePath(line.slice(3))
      currentEntry = { branches: new Map(), lines: new Map() }
      coverage.set(file, currentEntry)
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
        currentEntry.lines.set(lineNo, hits)
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
      currentEntry.branches.set(key, taken)
    }
  }

  return coverage
}

function headCommitMessage(): string {
  try {
    return execSync("git log -1 --format=%B HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
  } catch {
    return ""
  }
}

function fileExistsOnDisk(repoRelativePath: string): boolean {
  return existsSync(resolve(process.cwd(), repoRelativePath))
}

function diffCoverage(
  current: Coverage,
  baseline: Coverage
): {
  branchRegressions: BranchRegression[]
  lineRegressions: LineRegression[]
} {
  const lineRegressions: LineRegression[] = []
  const branchRegressions: BranchRegression[] = []
  let baselineFilesOnDisk = 0

  for (const [file, baselineEntry] of baseline) {
    if (!fileExistsOnDisk(file)) continue
    baselineFilesOnDisk += 1
    const currentEntry = current.get(file)

    for (const [line, baselineHits] of baselineEntry.lines) {
      if (baselineHits === 0) continue
      const currentHits = currentEntry?.lines.get(line) ?? 0
      if (currentHits === 0) {
        lineRegressions.push({ baselineHits, currentHits, file, line })
      }
    }

    for (const [key, baselineTaken] of baselineEntry.branches) {
      if (baselineTaken === 0) continue
      const currentTaken = currentEntry?.branches.get(key) ?? 0
      if (currentTaken === 0) {
        const [lineStr] = key.split(":")
        branchRegressions.push({
          baselineTaken,
          branchKey: key,
          currentTaken,
          file,
          line: Number(lineStr),
        })
      }
    }
  }

  if (baseline.size > 0 && baselineFilesOnDisk === 0) {
    console.error(
      `error: baseline references ${baseline.size} file(s) but none of them exist on disk relative to ${process.cwd()}. ` +
        "This usually means the baseline lcov was generated in a different environment and the SF: paths cannot be normalized. " +
        "Inspect the baseline's SF: entries."
    )
    process.exit(2)
  }

  return { branchRegressions, lineRegressions }
}

function printMarkdownReport(
  lineRegressions: LineRegression[],
  branchRegressions: BranchRegression[]
): void {
  console.log("## Coverage regression report\n")

  if (lineRegressions.length > 0) {
    console.log(`### Lines no longer covered (${lineRegressions.length})\n`)
    console.log("| File | Line | Baseline hits | Current hits |")
    console.log("|---|---:|---:|---:|")
    for (const r of lineRegressions) {
      console.log(
        `| \`${r.file}\` | ${r.line} | ${r.baselineHits} | ${r.currentHits} |`
      )
    }
    console.log("")
  }

  if (branchRegressions.length > 0) {
    console.log(`### Branches no longer taken (${branchRegressions.length})\n`)
    console.log(
      "| File | Line | Branch (line:block:branch) | Baseline taken | Current taken |"
    )
    console.log("|---|---:|---|---:|---:|")
    for (const r of branchRegressions) {
      console.log(
        `| \`${r.file}\` | ${r.line} | ${r.branchKey} | ${r.baselineTaken} | ${r.currentTaken} |`
      )
    }
    console.log("")
  }
}

function main(): void {
  const [, , currentArg, baselineArg] = process.argv
  if (!currentArg) {
    console.error("usage: coverage-diff <current-lcov> [baseline-lcov]")
    process.exit(2)
  }

  const currentPath = resolve(process.cwd(), currentArg)
  if (!existsSync(currentPath)) {
    console.error(`error: current lcov not found at ${currentPath}`)
    process.exit(2)
  }

  if (!baselineArg) {
    console.log("no baseline path provided, gate disabled")
    process.exit(0)
  }

  const baselinePath = resolve(process.cwd(), baselineArg)
  if (!existsSync(baselinePath)) {
    console.error(
      `error: baseline lcov not found at ${baselinePath}. To run without enforcement, omit the baseline argument.`
    )
    process.exit(2)
  }

  if (headCommitMessage().includes(REFRESH_TAG)) {
    console.log(
      `baseline refresh acknowledged via ${REFRESH_TAG} commit-message tag, gate skipped`
    )
    process.exit(0)
  }

  const current = parseLcov(readFileSync(currentPath, "utf8"))
  const baseline = parseLcov(readFileSync(baselinePath, "utf8"))

  const { branchRegressions, lineRegressions } = diffCoverage(current, baseline)

  if (lineRegressions.length === 0 && branchRegressions.length === 0) {
    console.log("no coverage regressions")
    process.exit(0)
  }

  printMarkdownReport(lineRegressions, branchRegressions)
  process.exit(1)
}

main()
