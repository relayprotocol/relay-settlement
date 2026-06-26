import assert from "node:assert/strict"
import test from "node:test"
import {
  TransferReplayRequestError,
  buildTransferReplayProgress,
  buildTransferReplayRequest,
  getTransferLogsWithSplit,
} from "./transferReplay.js"
import type { Provider } from "ethers"

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

test("getTransferLogsWithSplit splits oversized log ranges", async () => {
  const calls: Array<[number, number]> = []
  const responseTooLargeError = Object.assign(
    new Error("could not coalesce error"),
    {
      error: {
        code: -32005,
        message: "Response size exceeds limit",
      },
    }
  )
  const provider = {
    getLogs: async (filter: { fromBlock: number; toBlock: number }) => {
      calls.push([filter.fromBlock, filter.toBlock])
      if (filter.fromBlock === 10 && filter.toBlock === 13) {
        throw responseTooLargeError
      }

      return [
        {
          blockNumber: filter.fromBlock,
          data: "0x",
          index: 0,
          topics: [],
          transactionHash: `0x${filter.fromBlock.toString(16).padStart(64, "0")}`,
        },
      ]
    },
  } as unknown as Provider

  const logs = await getTransferLogsWithSplit(provider, {
    address: "0x0000000000000000000000000000000000000001",
    fromBlock: 10,
    toBlock: 13,
    topic: "0x0",
  })

  assert.deepEqual(calls, [
    [10, 13],
    [10, 11],
    [12, 13],
  ])
  assert.equal(logs.length, 2)
})

test("getTransferLogsWithSplit uses cursor pagination for oversized single-block ranges", async () => {
  const responseTooLargeError = Object.assign(
    new Error("could not coalesce error"),
    {
      error: {
        code: -32005,
        message: "Response size exceeds limit",
      },
    }
  )
  const calls: Array<Record<string, unknown>> = []
  const provider = {
    getLogs: async () => {
      throw responseTooLargeError
    },
    send: async (method: string, params: [Record<string, unknown>]) => {
      assert.equal(method, "eth_getLogsWithCursor")
      calls.push(params[0])
      return calls.length === 1
        ? {
            cursor: "next",
            logs: [
              {
                blockNumber: "0xa",
                data: "0x",
                logIndex: "0x1",
                topics: ["0x0"],
                transactionHash: "0x1",
              },
            ],
          }
        : {
            logs: [
              {
                blockNumber: "0xa",
                data: "0x",
                logIndex: "0x2",
                topics: ["0x0"],
                transactionHash: "0x2",
              },
            ],
          }
    },
  } as unknown as Provider

  const logs = await getTransferLogsWithSplit(provider, {
    address: "0x0000000000000000000000000000000000000001",
    fromBlock: 10,
    toBlock: 10,
    topic: "0x0",
  })

  assert.deepEqual(calls, [
    {
      address: "0x0000000000000000000000000000000000000001",
      fromBlock: "0xa",
      toBlock: "0xa",
      topics: [["0x0"]],
    },
    {
      address: "0x0000000000000000000000000000000000000001",
      cursor: "next",
      fromBlock: "0xa",
      toBlock: "0xa",
      topics: [["0x0"]],
    },
  ])
  assert.deepEqual(logs, [
    {
      blockNumber: 10,
      data: "0x",
      index: 1,
      topics: ["0x0"],
      transactionHash: "0x1",
    },
    {
      blockNumber: 10,
      data: "0x",
      index: 2,
      topics: ["0x0"],
      transactionHash: "0x2",
    },
  ])
})
