import assert from "node:assert/strict"
import test from "node:test"
import {
  TransferReplayRequestError,
  buildTransferReplayProgress,
  buildTransferReplayRequest,
} from "./transferReplay.js"

test("buildTransferReplayRequest accepts a bounded range", () => {
  assert.deepEqual(
    buildTransferReplayRequest(
      {
        fromBlock: 10,
        toBlock: 20,
      },
      {
        batchSize: 2000,
        reconcileChunkSize: 100,
      },
      {
        maxBlockRange: 100,
      }
    ),
    {
      batchSize: 2000,
      fromBlock: 10,
      reconcileChunkSize: 100,
      toBlock: 20,
    }
  )
})

test("buildTransferReplayRequest rejects zero batch and chunk sizes", () => {
  assert.throws(
    () =>
      buildTransferReplayRequest(
        {
          batchSize: 0,
          fromBlock: 10,
          toBlock: 20,
        },
        {
          batchSize: 2000,
          reconcileChunkSize: 100,
        }
      ),
    TransferReplayRequestError
  )

  assert.throws(
    () =>
      buildTransferReplayRequest(
        {
          fromBlock: 10,
          reconcileChunkSize: 0,
          toBlock: 20,
        },
        {
          batchSize: 2000,
          reconcileChunkSize: 100,
        }
      ),
    TransferReplayRequestError
  )
})

test("buildTransferReplayRequest rejects missing required blocks", () => {
  assert.throws(
    () =>
      buildTransferReplayRequest(
        {
          fromBlock: null,
          toBlock: 20,
        },
        {
          batchSize: 2000,
          reconcileChunkSize: 100,
        }
      ),
    {
      message: "fromBlock is required",
    }
  )

  assert.throws(
    () =>
      buildTransferReplayRequest(
        {
          fromBlock: 10,
          toBlock: undefined,
        },
        {
          batchSize: 2000,
          reconcileChunkSize: 100,
        }
      ),
    {
      message: "toBlock is required",
    }
  )
})

test("buildTransferReplayRequest rejects coercive integer values", () => {
  for (const value of ["", "   ", true, false, [], {}]) {
    assert.throws(
      () =>
        buildTransferReplayRequest(
          {
            fromBlock: value,
            toBlock: 20,
          },
          {
            batchSize: 2000,
            reconcileChunkSize: 100,
          }
        ),
      TransferReplayRequestError
    )
  }
})

test("buildTransferReplayRequest enforces max block range", () => {
  assert.throws(
    () =>
      buildTransferReplayRequest(
        {
          fromBlock: 10,
          toBlock: 20,
        },
        {
          batchSize: 2000,
          reconcileChunkSize: 100,
        },
        {
          maxBlockRange: 10,
        }
      ),
    {
      message: "block range (11) exceeds maxBlockRange (10)",
    }
  )
})

test("buildTransferReplayProgress reports initial replay progress", () => {
  const progress = buildTransferReplayProgress(
    {
      batchSize: 10,
      fromBlock: 10,
      reconcileChunkSize: 100,
      toBlock: 20,
    },
    {
      decoded: 0,
      inserted: 0,
      reconciledAddresses: 0,
      skipped: 0,
    },
    Date.now(),
    {
      currentBlock: null,
      lastBatchFromBlock: null,
      lastBatchToBlock: null,
    }
  )

  assert.equal(progress.currentBlock, null)
  assert.equal(progress.lastBatchFromBlock, null)
  assert.equal(progress.lastBatchToBlock, null)
  assert.equal(progress.percentComplete, 0)
  assert.equal(progress.processedBlocks, 0)
  assert.equal(progress.remainingBlocks, 11)
  assert.equal(progress.totalBlocks, 11)
  assert.equal(progress.blocksPerSecond, null)
  assert.equal(progress.estimatedRemainingSeconds, null)
})

test("buildTransferReplayProgress reports completed replay progress", () => {
  const progress = buildTransferReplayProgress(
    {
      batchSize: 10,
      fromBlock: 10,
      reconcileChunkSize: 100,
      toBlock: 20,
    },
    {
      decoded: 3,
      inserted: 2,
      reconciledAddresses: 4,
      skipped: 1,
    },
    Date.now() - 1000,
    {
      currentBlock: 20,
      lastBatchFromBlock: 20,
      lastBatchToBlock: 20,
    }
  )

  assert.equal(progress.currentBlock, 20)
  assert.equal(progress.lastBatchFromBlock, 20)
  assert.equal(progress.lastBatchToBlock, 20)
  assert.equal(progress.percentComplete, 100)
  assert.equal(progress.processedBlocks, 11)
  assert.equal(progress.remainingBlocks, 0)
  assert.equal(progress.decoded, 3)
  assert.equal(progress.inserted, 2)
  assert.equal(progress.reconciledAddresses, 4)
  assert.equal(progress.skipped, 1)
  assert.equal(progress.estimatedRemainingSeconds, 0)
})
