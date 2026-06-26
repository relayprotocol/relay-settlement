import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import {
  TransferReplayJob,
  TransferReplayRequest,
  fetchTransferReplayJob,
  startTransferReplay,
} from "../api"

const DEFAULT_BATCH_SIZE = "2000"
const DEFAULT_RECONCILE_CHUNK_SIZE = "100"
const BATCH_SIZE_OPTIONS = ["500", "1000", DEFAULT_BATCH_SIZE, "5000"]
const RECONCILE_CHUNK_OPTIONS = [
  "25",
  "50",
  DEFAULT_RECONCILE_CHUNK_SIZE,
  "250",
  "500",
]

export default function AdminReplayPage() {
  const [replayFromBlock, setReplayFromBlock] = useState<string>("")
  const [replayToBlock, setReplayToBlock] = useState<string>("")
  const [replayBatchSize, setReplayBatchSize] =
    useState<string>(DEFAULT_BATCH_SIZE)
  const [replayChunkSize, setReplayChunkSize] = useState<string>(
    DEFAULT_RECONCILE_CHUNK_SIZE
  )
  const [replayJob, setReplayJob] = useState<TransferReplayJob | null>(null)
  const [replayError, setReplayError] = useState<string>("")
  const [isStartingReplay, setIsStartingReplay] = useState<boolean>(false)
  const [pendingReplayRequest, setPendingReplayRequest] =
    useState<TransferReplayRequest | null>(null)
  const replayProgress = replayJob?.progress ?? null

  useEffect(() => {
    if (!replayJob || replayJob.state !== "running") {
      return
    }

    const interval = setInterval(async () => {
      try {
        const next = await fetchTransferReplayJob(replayJob.id)
        setReplayJob(next)
        setReplayError("")
      } catch (err) {
        setReplayError(
          err instanceof Error ? err.message : "Failed to refresh replay job"
        )
      }
    }, 3000)

    return () => clearInterval(interval)
  }, [replayJob?.id, replayJob?.state])

  const parseReplayInteger = (value: string, label: string) => {
    if (!value.trim()) {
      throw new Error(`${label} is required`)
    }

    const parsed = Number(value)
    if (!Number.isInteger(parsed)) {
      throw new Error(`${label} must be an integer`)
    }
    return parsed
  }

  const formatNumber = (value: number) => value.toLocaleString("en-US")

  const formatDuration = (seconds: number | null) => {
    if (seconds == null) {
      return "-"
    }

    if (seconds < 60) {
      return `${Math.ceil(seconds)}s`
    }

    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = Math.ceil(seconds % 60)
    return `${minutes}m ${remainingSeconds}s`
  }

  const buildReplayRequest = () => {
    const fromBlock = parseReplayInteger(replayFromBlock, "From block")
    const toBlock = parseReplayInteger(replayToBlock, "To block")
    if (fromBlock < 0 || toBlock < 0) {
      throw new Error("Block numbers must be >= 0")
    }
    if (fromBlock > toBlock) {
      throw new Error("From block must be less than or equal to to block")
    }

    const batchSize = parseReplayInteger(replayBatchSize, "Batch size")
    if (batchSize < 1) {
      throw new Error("Batch size must be >= 1")
    }

    const reconcileChunkSize = parseReplayInteger(
      replayChunkSize,
      "Reconcile chunk"
    )
    if (reconcileChunkSize < 1) {
      throw new Error("Reconcile chunk must be >= 1")
    }

    return {
      batchSize,
      fromBlock,
      reconcileChunkSize,
      toBlock,
    }
  }

  const handleStartReplay = () => {
    setReplayError("")

    try {
      setPendingReplayRequest(buildReplayRequest())
    } catch (err) {
      setReplayError(
        err instanceof Error ? err.message : "Failed to validate replay request"
      )
    }
  }

  const handleConfirmReplay = async () => {
    if (!pendingReplayRequest) return

    setReplayError("")
    try {
      setIsStartingReplay(true)
      const job = await startTransferReplay(pendingReplayRequest)
      setReplayJob(job)
      setPendingReplayRequest(null)
    } catch (err) {
      setReplayError(
        err instanceof Error ? err.message : "Failed to start transfer replay"
      )
    } finally {
      setIsStartingReplay(false)
    }
  }

  const handleRefreshReplay = async () => {
    if (!replayJob) return

    try {
      const next = await fetchTransferReplayJob(replayJob.id)
      setReplayJob(next)
      setReplayError("")
    } catch (err) {
      setReplayError(
        err instanceof Error ? err.message : "Failed to refresh replay job"
      )
    }
  }

  const pendingBlockRange = pendingReplayRequest
    ? pendingReplayRequest.toBlock - pendingReplayRequest.fromBlock + 1
    : 0

  return (
    <div className="app">
      <header className="hero">
        <div>
          <p className="eyebrow">Admin maintenance</p>
          <h1>Transfer replay</h1>
        </div>
        <Link className="btn ghost" to="/">
          Back to overview
        </Link>
      </header>

      <section className="panel admin-panel">
        <div className="panel-header">
          <div>
            <h2>Backfill transfer range</h2>
          </div>
          {replayJob ? (
            <span className={`status-pill ${replayJob.state}`}>
              {replayJob.state}
            </span>
          ) : null}
        </div>
        <p className="muted">
          Backfill missed transfer logs and reconcile touched balances from
          on-chain state. Use this only for bounded incident repair ranges.
        </p>

        <div className="admin-form">
          <label>
            <span className="label">From block</span>
            <input
              inputMode="numeric"
              placeholder="1637552"
              value={replayFromBlock}
              onChange={(event) => setReplayFromBlock(event.target.value)}
            />
          </label>
          <label>
            <span className="label">To block</span>
            <input
              inputMode="numeric"
              placeholder="1637584"
              value={replayToBlock}
              onChange={(event) => setReplayToBlock(event.target.value)}
            />
          </label>
          <label>
            <span className="label">Batch size</span>
            <select
              value={replayBatchSize}
              onChange={(event) => setReplayBatchSize(event.target.value)}
            >
              {BATCH_SIZE_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {formatNumber(Number(value))}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="label">Reconcile chunk</span>
            <select
              value={replayChunkSize}
              onChange={(event) => setReplayChunkSize(event.target.value)}
            >
              {RECONCILE_CHUNK_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {formatNumber(Number(value))}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn danger"
            disabled={isStartingReplay || replayJob?.state === "running"}
            onClick={handleStartReplay}
          >
            Review replay
          </button>
        </div>

        {replayError && !pendingReplayRequest ? (
          <div className="banner">{replayError}</div>
        ) : null}

        {replayJob ? (
          <div className="replay-status">
            <div className="replay-status-header">
              <div>
                <p className="label">Job</p>
                <p className="value">{replayJob.id}</p>
              </div>
              <div className="job-actions">
                <span className={`status-pill ${replayJob.state}`}>
                  {replayJob.state}
                </span>
                <button className="btn ghost" onClick={handleRefreshReplay}>
                  Refresh status
                </button>
              </div>
            </div>

            {replayProgress ? (
              <>
                <div className="progress-summary">
                  <div>
                    <p className="label">Progress</p>
                    <p className="progress-percent">
                      {replayProgress.percentComplete.toFixed(2)}%
                    </p>
                  </div>
                  <div>
                    <p className="label">Blocks</p>
                    <p className="value">
                      {formatNumber(replayProgress.processedBlocks)} /{" "}
                      {formatNumber(replayProgress.totalBlocks)}
                    </p>
                  </div>
                  <div>
                    <p className="label">ETA</p>
                    <p className="value">
                      {formatDuration(replayProgress.estimatedRemainingSeconds)}
                    </p>
                  </div>
                </div>
                <div className="progress-track">
                  <div
                    className="progress-fill"
                    style={{
                      width: `${Math.min(
                        100,
                        replayProgress.percentComplete
                      )}%`,
                    }}
                  />
                </div>
                <div className="stat replay-grid">
                  <div>
                    <p className="label">Range</p>
                    <p className="value">
                      {formatNumber(replayProgress.fromBlock)}-
                      {formatNumber(replayProgress.toBlock)}
                    </p>
                  </div>
                  <div>
                    <p className="label">Current block</p>
                    <p className="value">
                      {replayProgress.currentBlock == null
                        ? "-"
                        : formatNumber(replayProgress.currentBlock)}
                    </p>
                  </div>
                  <div>
                    <p className="label">Remaining</p>
                    <p className="value">
                      {formatNumber(replayProgress.remainingBlocks)}
                    </p>
                  </div>
                  <div>
                    <p className="label">Speed</p>
                    <p className="value">
                      {replayProgress.blocksPerSecond == null
                        ? "-"
                        : `${replayProgress.blocksPerSecond.toFixed(2)} blocks/s`}
                    </p>
                  </div>
                  <div>
                    <p className="label">Decoded</p>
                    <p className="value">
                      {formatNumber(replayProgress.decoded)}
                    </p>
                  </div>
                  <div>
                    <p className="label">Inserted</p>
                    <p className="value">
                      {formatNumber(replayProgress.inserted)}
                    </p>
                  </div>
                  <div>
                    <p className="label">Reconciled</p>
                    <p className="value">
                      {formatNumber(replayProgress.reconciledAddresses)}
                    </p>
                  </div>
                  <div>
                    <p className="label">Skipped</p>
                    <p className="value">
                      {formatNumber(replayProgress.skipped)}
                    </p>
                  </div>
                  <div>
                    <p className="label">Elapsed</p>
                    <p className="value">
                      {formatDuration(replayProgress.elapsedMs / 1000)}
                    </p>
                  </div>
                  <div>
                    <p className="label">Last batch</p>
                    <p className="value">
                      {replayProgress.lastBatchFromBlock == null ||
                      replayProgress.lastBatchToBlock == null
                        ? "-"
                        : `${formatNumber(
                            replayProgress.lastBatchFromBlock
                          )}-${formatNumber(replayProgress.lastBatchToBlock)}`}
                    </p>
                  </div>
                  <div>
                    <p className="label">Updated</p>
                    <p className="value">
                      {new Date(replayProgress.updatedAt).toLocaleTimeString(
                        "en-US"
                      )}
                    </p>
                  </div>
                </div>
              </>
            ) : null}

            {replayJob.error ? (
              <div className="banner">{replayJob.error}</div>
            ) : null}
          </div>
        ) : null}
      </section>

      {pendingReplayRequest ? (
        <div className="modal-backdrop" role="presentation">
          <div
            aria-labelledby="replay-confirm-title"
            aria-modal="true"
            className="modal"
            role="dialog"
          >
            <div className="modal-header">
              <div>
                <p className="eyebrow">Confirm mutation</p>
                <h2 id="replay-confirm-title">Start transfer replay?</h2>
              </div>
              <button
                className="modal-close"
                onClick={() => setPendingReplayRequest(null)}
              >
                Close
              </button>
            </div>

            <p className="muted">
              This will backfill transfer logs for the selected range and mutate
              indexed events, balances, holder counts, and token transfer
              totals. Use it only for a bounded incident repair range.
            </p>

            {replayError ? <div className="banner">{replayError}</div> : null}

            <div className="stat replay-grid">
              <div>
                <p className="label">Range</p>
                <p className="value">
                  {formatNumber(pendingReplayRequest.fromBlock)}-
                  {formatNumber(pendingReplayRequest.toBlock)}
                </p>
              </div>
              <div>
                <p className="label">Blocks</p>
                <p className="value">{formatNumber(pendingBlockRange)}</p>
              </div>
              <div>
                <p className="label">Batch size</p>
                <p className="value">
                  {formatNumber(pendingReplayRequest.batchSize)}
                </p>
              </div>
              <div>
                <p className="label">Reconcile chunk</p>
                <p className="value">
                  {formatNumber(pendingReplayRequest.reconcileChunkSize)}
                </p>
              </div>
            </div>

            <div className="modal-actions">
              <button
                className="btn ghost"
                disabled={isStartingReplay}
                onClick={() => setPendingReplayRequest(null)}
              >
                Cancel
              </button>
              <button
                className="btn danger"
                disabled={isStartingReplay}
                onClick={handleConfirmReplay}
              >
                {isStartingReplay ? "Starting..." : "Start replay"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
