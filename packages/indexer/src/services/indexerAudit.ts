import { RelayHub } from "@relay-protocol/settlement-abis"
import { Contract, Interface, JsonRpcProvider, type Provider } from "ethers"
import type { Database, Queryable } from "../db/connection.js"
import { getMeta } from "../db/meta.js"
import { HUB_TRANSFER_META_KEY } from "../indexerState.js"
import { shouldSkipTokenId, parseTransferLog } from "./transferProcessor.js"
import { isGetLogsResponseTooLargeError } from "./transferReplay.js"

export const INDEXER_AUDIT_KINDS = ["transfer-coverage"] as const

export type IndexerAuditKind = (typeof INDEXER_AUDIT_KINDS)[number]
export type IndexerAuditStatus = "failed" | "running" | "succeeded"
export type IndexerAuditClassification = "confirmed"

export type SuggestedReplayRange = {
  findingCount: number
  fromBlock: number
  reason: IndexerAuditKind | "multiple"
  toBlock: number
}

export type IndexerAuditFinding = {
  blockNumber: number | null
  classification: IndexerAuditClassification
  details: Record<string, unknown>
  id?: number
  kind: IndexerAuditKind
  logIndex: number | null
  tokenId: string | null
  tokenName: string | null
  txHash: string | null
}

export type IndexerAuditRunSummary = {
  auditBlock: number | null
  checkedCount: number
  completedAt: string | null
  confirmedCount: number
  error: string | null
  id: number
  kind: IndexerAuditKind
  latestChainBlock: number | null
  startedAt: string
  status: IndexerAuditStatus
}

export type IndexerAuditKindHealth = {
  auditBlock: number | null
  checkedCount: number
  completedAt: string | null
  confirmedCount: number
  consecutiveConfirmedRuns: number
  error: string | null
  kind: IndexerAuditKind
  ok: boolean
  reason: string | null
  startedAt: string | null
  status: IndexerAuditStatus | "missing" | "stale"
}

export type IndexerAuditHealth = {
  consecutiveFailures: number
  failureThreshold: number
  kinds: IndexerAuditKindHealth[]
  maxAgeMs: number
  ok: boolean
}

export type IndexerAuditReport = {
  findings: IndexerAuditFinding[]
  generatedAt: string
  groupedFindings: Array<{
    classification: IndexerAuditClassification
    count: number
    kind: IndexerAuditKind
  }>
  health: IndexerAuditHealth
  ok: boolean
  runs: IndexerAuditRunSummary[]
  suggestedReplayRanges: SuggestedReplayRange[]
}

type AuditRunRow = {
  audit_block: number | string | null
  checked_count: number | string
  completed_at: Date | string | null
  confirmed_count: number | string
  error: string | null
  id: number | string
  kind: IndexerAuditKind
  latest_chain_block: number | string | null
  started_at: Date | string
  status: IndexerAuditStatus
}

type AuditFindingRow = {
  block_number: number | string | null
  classification: IndexerAuditClassification
  details_json: string
  id: number | string
  kind: IndexerAuditKind
  log_index: number | string | null
  token_id: string | null
  token_name: string | null
  tx_hash: string | null
}

type ChainLog = {
  blockNumber: number
  data: string
  index: number
  topics: readonly string[]
  transactionHash: string
}

type RunAuditOptions = {
  auditBlock?: number
  latestChainBlock?: number
}

export type TransferCoverageAuditOptions = RunAuditOptions & {
  lookbackBlocks: number
  maxReplayRange: number
  replayPaddingBlocks: number
}

export type IndexerAuditHealthOptions = {
  consecutiveFailures: number
  failureThreshold: number
  maxAgeMs: number
  now?: Date
}

const relayHubInterface = new Interface(RelayHub)
const transferTopic = relayHubInterface.getEvent("Transfer")?.topicHash

if (!transferTopic) {
  throw new Error("Transfer event topic hash not found in ABI")
}

const normalizeTimestamp = (value: Date | string | null) => {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

const normalizeNumber = (value: number | string | null) =>
  value == null ? null : Number(value)

const normalizeRun = (row: AuditRunRow): IndexerAuditRunSummary => ({
  auditBlock: normalizeNumber(row.audit_block),
  checkedCount: Number(row.checked_count),
  completedAt: normalizeTimestamp(row.completed_at),
  confirmedCount: Number(row.confirmed_count),
  error: row.error,
  id: Number(row.id),
  kind: row.kind,
  latestChainBlock: normalizeNumber(row.latest_chain_block),
  startedAt: normalizeTimestamp(row.started_at) as string,
  status: row.status,
})

const parseDetails = (value: string) => {
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    return {}
  }
}

const normalizeFinding = (row: AuditFindingRow): IndexerAuditFinding => ({
  blockNumber: normalizeNumber(row.block_number),
  classification: row.classification,
  details: parseDetails(row.details_json),
  id: Number(row.id),
  kind: row.kind,
  logIndex: normalizeNumber(row.log_index),
  tokenId: row.token_id,
  tokenName: row.token_name,
  txHash: row.tx_hash,
})

export const buildSuggestedReplayRanges = (
  blocks: number[],
  options: {
    maxRange: number
    padding: number
    reason: IndexerAuditKind
  }
): SuggestedReplayRange[] => {
  const maxRange = Math.max(1, Math.trunc(options.maxRange))
  const padding = Math.max(0, Math.trunc(options.padding))
  const ranges = blocks
    .filter((block) => Number.isInteger(block) && block >= 0)
    .map((block) => ({
      findingCount: 1,
      fromBlock: Math.max(0, block - padding),
      reason: options.reason,
      toBlock: block + padding,
    }))
    .sort((a, b) => a.fromBlock - b.fromBlock || a.toBlock - b.toBlock)

  const merged: SuggestedReplayRange[] = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last && range.fromBlock <= last.toBlock + 1) {
      last.toBlock = Math.max(last.toBlock, range.toBlock)
      last.findingCount += range.findingCount
      if (last.reason !== range.reason) {
        last.reason = "multiple"
      }
    } else {
      merged.push({ ...range })
    }
  }

  const capped: SuggestedReplayRange[] = []
  for (const range of merged) {
    let fromBlock = range.fromBlock
    while (fromBlock <= range.toBlock) {
      const toBlock = Math.min(fromBlock + maxRange - 1, range.toBlock)
      capped.push({
        ...range,
        fromBlock,
        toBlock,
      })
      fromBlock = toBlock + 1
    }
  }

  return capped
}

export const mergeSuggestedReplayRanges = (
  ranges: SuggestedReplayRange[],
  maxRange: number
): SuggestedReplayRange[] => {
  const cappedMaxRange = Math.max(1, Math.trunc(maxRange))
  const sorted = ranges
    .map((range) => ({ ...range }))
    .sort((a, b) => a.fromBlock - b.fromBlock || a.toBlock - b.toBlock)
  const merged: SuggestedReplayRange[] = []

  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.fromBlock <= last.toBlock + 1) {
      last.toBlock = Math.max(last.toBlock, range.toBlock)
      last.findingCount += range.findingCount
      if (last.reason !== range.reason) {
        last.reason = "multiple"
      }
    } else {
      merged.push(range)
    }
  }

  const capped: SuggestedReplayRange[] = []
  for (const range of merged) {
    let fromBlock = range.fromBlock
    while (fromBlock <= range.toBlock) {
      const toBlock = Math.min(fromBlock + cappedMaxRange - 1, range.toBlock)
      capped.push({
        ...range,
        fromBlock,
        toBlock,
      })
      fromBlock = toBlock + 1
    }
  }
  return capped
}

const toHex = (block: number) => `0x${block.toString(16)}`

const normalizeProviderLog = (log: {
  blockNumber: number | string
  data: string
  index?: number
  logIndex?: number | string
  topics: readonly string[]
  transactionHash: string
}): ChainLog => ({
  blockNumber:
    typeof log.blockNumber === "string"
      ? Number(log.blockNumber)
      : log.blockNumber,
  data: log.data,
  index:
    log.index ??
    (typeof log.logIndex === "string" ? Number(log.logIndex) : log.logIndex) ??
    0,
  topics: log.topics,
  transactionHash: log.transactionHash,
})

const getLogsWithSplitForFilter = async (
  provider: Provider,
  params: {
    address: string
    fromBlock: number
    toBlock: number
    topics: Array<string | string[] | null>
  }
): Promise<ChainLog[]> => {
  const fetchLogsWithCursor = async () => {
    const allLogs: ChainLog[] = []
    let cursor: string | undefined

    do {
      const filter: Record<string, unknown> = {
        address: params.address,
        fromBlock: toHex(params.fromBlock),
        toBlock: toHex(params.toBlock),
        topics: params.topics,
      }
      if (cursor) {
        filter.cursor = cursor
      }

      const result = (await (provider as JsonRpcProvider).send(
        "eth_getLogsWithCursor",
        [filter]
      )) as {
        cursor?: string | null
        logs?: Array<{
          blockNumber: string
          data: string
          logIndex: string
          topics: string[]
          transactionHash: string
        }>
      }

      for (const log of result.logs ?? []) {
        allLogs.push(normalizeProviderLog(log))
      }
      cursor = result.cursor ?? undefined
    } while (cursor)

    return allLogs
  }

  try {
    const logs = await provider.getLogs({
      address: params.address,
      fromBlock: params.fromBlock,
      toBlock: params.toBlock,
      topics: params.topics,
    })
    return logs.map(normalizeProviderLog)
  } catch (error) {
    if (!isGetLogsResponseTooLargeError(error)) {
      throw error
    }

    if (params.fromBlock >= params.toBlock) {
      return fetchLogsWithCursor()
    }

    const midpoint = Math.floor((params.fromBlock + params.toBlock) / 2)
    const left = await getLogsWithSplitForFilter(provider, {
      ...params,
      toBlock: midpoint,
    })
    const right = await getLogsWithSplitForFilter(provider, {
      ...params,
      fromBlock: midpoint + 1,
    })
    return [...left, ...right]
  }
}

const getAuditBlock = async (
  db: Queryable,
  override?: number
): Promise<number> => {
  if (override != null) {
    return override
  }

  const raw = await getMeta(db, HUB_TRANSFER_META_KEY)
  const parsed = raw == null ? null : Number(raw)
  if (parsed == null || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      "Hub transfer checkpoint is not available for indexer audit"
    )
  }
  return parsed
}

const insertAuditRun = async (
  db: Queryable,
  kind: IndexerAuditKind
): Promise<number> => {
  const now = new Date().toISOString()
  const row = await db.one<{ id: number }>(
    `INSERT INTO indexer_audit_runs(kind, status, started_at, created_at, updated_at)
     VALUES($1, $2, $3, $3, $3)
     RETURNING id`,
    [kind, "running", now]
  )
  return Number(row.id)
}

const completeAuditRun = async (
  db: Queryable,
  runId: number,
  input: {
    auditBlock: number | null
    checkedCount: number
    confirmedCount: number
    error?: string | null
    latestChainBlock: number | null
    status: IndexerAuditStatus
  }
) => {
  const now = new Date().toISOString()
  await db.none(
    `UPDATE indexer_audit_runs
     SET status = $1,
         completed_at = $2,
         audit_block = $3,
         latest_chain_block = $4,
         checked_count = $5,
         confirmed_count = $6,
         error = $7,
         updated_at = $2
     WHERE id = $8`,
    [
      input.status,
      now,
      input.auditBlock,
      input.latestChainBlock,
      input.checkedCount,
      input.confirmedCount,
      input.error ?? null,
      runId,
    ]
  )
}

const insertAuditFindings = async (
  db: Queryable,
  runId: number,
  findings: IndexerAuditFinding[]
) => {
  const now = new Date().toISOString()
  for (const finding of findings) {
    await db.none(
      `INSERT INTO indexer_audit_findings(
        run_id, kind, classification, token_id, token_name, block_number,
        tx_hash, log_index, details_json, created_at, updated_at
      ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
      [
        runId,
        finding.kind,
        finding.classification,
        finding.tokenId,
        finding.tokenName,
        finding.blockNumber,
        finding.txHash,
        finding.logIndex,
        JSON.stringify(finding.details),
        now,
      ]
    )
  }
}

const withAuditRun = async (
  db: Database,
  kind: IndexerAuditKind,
  run: (_db: Queryable) => Promise<{
    auditBlock: number
    checkedCount: number
    findings: IndexerAuditFinding[]
    latestChainBlock: number
  }>
) => {
  const runId = await insertAuditRun(db, kind)

  try {
    const result = await run(db)
    await insertAuditFindings(db, runId, result.findings)

    const confirmedCount = result.findings.filter(
      (finding) => finding.classification === "confirmed"
    ).length
    await completeAuditRun(db, runId, {
      auditBlock: result.auditBlock,
      checkedCount: result.checkedCount,
      confirmedCount,
      latestChainBlock: result.latestChainBlock,
      status: "succeeded",
    })

    return {
      ...result,
      confirmedCount,
      runId,
    }
  } catch (error) {
    await completeAuditRun(db, runId, {
      auditBlock: null,
      checkedCount: 0,
      confirmedCount: 0,
      error: error instanceof Error ? error.message : String(error),
      latestChainBlock: null,
      status: "failed",
    })
    throw error
  }
}

const getIndexedEventKeys = async (
  db: Queryable,
  fromBlock: number,
  toBlock: number
) => {
  const rows = await db.manyOrNone<{
    log_index: number
    tx_hash: string
  }>(
    `SELECT tx_hash, log_index
     FROM events
     WHERE block_number BETWEEN $1 AND $2`,
    [fromBlock, toBlock]
  )
  return new Set(
    rows.map((row) => `${row.tx_hash.toLowerCase()}:${row.log_index}`)
  )
}

const getTokenNames = async (db: Queryable) => {
  const rows = await db.manyOrNone<{ name: string | null; token_id: string }>(
    "SELECT token_id, name FROM tokens"
  )
  return new Map(rows.map((row) => [row.token_id, row.name]))
}

export const runTransferCoverageAudit = async (
  db: Database,
  provider: Provider,
  hubContract: Contract,
  options: TransferCoverageAuditOptions
) =>
  withAuditRun(db, "transfer-coverage", async (tx) => {
    const auditBlock = await getAuditBlock(tx, options.auditBlock)
    const latestChainBlock =
      options.latestChainBlock ?? (await provider.getBlockNumber())
    const fromBlock = Math.max(0, auditBlock - options.lookbackBlocks + 1)
    const [logs, indexedKeys, tokenNames] = await Promise.all([
      getLogsWithSplitForFilter(provider, {
        address: hubContract.target as string,
        fromBlock,
        toBlock: auditBlock,
        topics: [transferTopic],
      }),
      getIndexedEventKeys(tx, fromBlock, auditBlock),
      getTokenNames(tx),
    ])

    const findings: IndexerAuditFinding[] = []
    let checkedCount = 0

    for (const log of logs.sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? a.index - b.index
        : a.blockNumber - b.blockNumber
    )) {
      const transfer = parseTransferLog(log)
      if (!transfer || shouldSkipTokenId(transfer.tokenId)) {
        continue
      }

      checkedCount += 1
      const eventKey = `${log.transactionHash.toLowerCase()}:${log.index}`
      if (indexedKeys.has(eventKey)) {
        continue
      }

      findings.push({
        blockNumber: log.blockNumber,
        classification: "confirmed",
        details: {
          amount: transfer.amount.toString(),
          from: transfer.from.toLowerCase(),
          operator: transfer.operator.toLowerCase(),
          suggestedReplayRanges: buildSuggestedReplayRanges([log.blockNumber], {
            maxRange: options.maxReplayRange,
            padding: options.replayPaddingBlocks,
            reason: "transfer-coverage",
          }),
          to: transfer.to.toLowerCase(),
        },
        kind: "transfer-coverage",
        logIndex: log.index,
        tokenId: transfer.tokenId,
        tokenName: tokenNames.get(transfer.tokenId) ?? null,
        txHash: log.transactionHash,
      })
    }

    return {
      auditBlock,
      checkedCount,
      findings,
      latestChainBlock,
    }
  })

const getLatestAuditRuns = async (db: Queryable) => {
  const rows = await db.manyOrNone<AuditRunRow>(
    `SELECT DISTINCT ON (kind)
       id, kind, status, started_at, completed_at, audit_block, latest_chain_block,
       checked_count, confirmed_count, error
     FROM indexer_audit_runs
     WHERE kind IN ($1:csv)
     ORDER BY kind, started_at DESC, id DESC`,
    [INDEXER_AUDIT_KINDS]
  )
  return rows.map(normalizeRun)
}

const getRecentCompletedRuns = async (
  db: Queryable,
  kind: IndexerAuditKind,
  limit: number
) => {
  const rows = await db.manyOrNone<AuditRunRow>(
    `SELECT id, kind, status, started_at, completed_at, audit_block, latest_chain_block,
            checked_count, confirmed_count, error
     FROM indexer_audit_runs
     WHERE kind = $1 AND status = 'succeeded' AND completed_at IS NOT NULL
     ORDER BY completed_at DESC, id DESC
     LIMIT $2`,
    [kind, limit]
  )
  return rows.map(normalizeRun)
}

export const getIndexerAuditHealth = async (
  db: Queryable,
  options: IndexerAuditHealthOptions
): Promise<IndexerAuditHealth> => {
  const maxAgeMs = Math.max(1, options.maxAgeMs)
  const failureThreshold = Math.max(1, options.failureThreshold)
  const consecutiveFailures = Math.max(1, options.consecutiveFailures)
  const nowMs = (options.now ?? new Date()).getTime()
  const latestRuns = await getLatestAuditRuns(db)
  const latestByKind = new Map(latestRuns.map((run) => [run.kind, run]))
  const kinds: IndexerAuditKindHealth[] = []

  for (const kind of INDEXER_AUDIT_KINDS) {
    const latest = latestByKind.get(kind)
    if (!latest) {
      kinds.push({
        auditBlock: null,
        checkedCount: 0,
        completedAt: null,
        confirmedCount: 0,
        consecutiveConfirmedRuns: 0,
        error: null,
        kind,
        ok: true,
        reason: null,
        startedAt: null,
        status: "missing",
      })
      continue
    }

    const completedAtMs = latest.completedAt
      ? new Date(latest.completedAt).getTime()
      : null
    const startedAtMs = new Date(latest.startedAt).getTime()
    let ok = true
    let reason: string | null = null
    let status: IndexerAuditKindHealth["status"] = latest.status

    if (latest.status === "failed") {
      ok = false
      reason = "latest audit failed"
    } else if (latest.status === "running" && nowMs - startedAtMs > maxAgeMs) {
      ok = false
      reason = "audit run is stale"
      status = "stale"
    } else if (completedAtMs != null && nowMs - completedAtMs > maxAgeMs) {
      ok = false
      reason = "latest audit is stale"
      status = "stale"
    }

    const recentRuns = await getRecentCompletedRuns(
      db,
      kind,
      consecutiveFailures
    )
    const consecutiveConfirmedRuns =
      recentRuns.length >= consecutiveFailures &&
      recentRuns.every((run) => run.confirmedCount >= failureThreshold)
        ? consecutiveFailures
        : 0

    if (ok && consecutiveConfirmedRuns >= consecutiveFailures) {
      ok = false
      reason = "confirmed audit findings exceeded threshold"
    }

    kinds.push({
      auditBlock: latest.auditBlock,
      checkedCount: latest.checkedCount,
      completedAt: latest.completedAt,
      confirmedCount: latest.confirmedCount,
      consecutiveConfirmedRuns,
      error: latest.error,
      kind,
      ok,
      reason,
      startedAt: latest.startedAt,
      status,
    })
  }

  return {
    consecutiveFailures,
    failureThreshold,
    kinds,
    maxAgeMs,
    ok: kinds.every((kind) => kind.ok),
  }
}

const getFindingsForRuns = async (db: Queryable, runIds: number[]) => {
  if (!runIds.length) {
    return []
  }

  const rows = await db.manyOrNone<AuditFindingRow>(
    `SELECT id, kind, classification, token_id, token_name,
            block_number, tx_hash, log_index, details_json
     FROM indexer_audit_findings
     WHERE run_id IN ($1:csv)
     ORDER BY classification ASC, kind ASC, block_number ASC NULLS LAST, id ASC`,
    [runIds]
  )
  return rows.map(normalizeFinding)
}

const extractSuggestedRanges = (findings: IndexerAuditFinding[]) =>
  findings.flatMap((finding) => {
    const ranges = finding.details.suggestedReplayRanges
    return Array.isArray(ranges)
      ? ranges.filter((range): range is SuggestedReplayRange => {
          if (typeof range !== "object" || range == null) return false
          const candidate = range as SuggestedReplayRange
          return (
            Number.isInteger(candidate.fromBlock) &&
            Number.isInteger(candidate.toBlock) &&
            Number.isInteger(candidate.findingCount)
          )
        })
      : []
  })

export const getLatestIndexerAuditReport = async (
  db: Queryable,
  options: IndexerAuditHealthOptions & {
    maxReplayRange: number
  }
): Promise<IndexerAuditReport> => {
  const [health, runs] = await Promise.all([
    getIndexerAuditHealth(db, options),
    getLatestAuditRuns(db),
  ])
  const findings = await getFindingsForRuns(
    db,
    runs.map((run) => run.id)
  )

  const grouped = new Map<
    string,
    {
      classification: IndexerAuditClassification
      count: number
      kind: IndexerAuditKind
    }
  >()
  for (const finding of findings) {
    const key = `${finding.kind}:${finding.classification}`
    const current = grouped.get(key) ?? {
      classification: finding.classification,
      count: 0,
      kind: finding.kind,
    }
    current.count += 1
    grouped.set(key, current)
  }

  return {
    findings,
    generatedAt: new Date().toISOString(),
    groupedFindings: [...grouped.values()],
    health,
    ok: health.ok,
    runs,
    suggestedReplayRanges: mergeSuggestedReplayRanges(
      extractSuggestedRanges(
        findings.filter((finding) => finding.classification === "confirmed")
      ),
      options.maxReplayRange
    ),
  }
}
