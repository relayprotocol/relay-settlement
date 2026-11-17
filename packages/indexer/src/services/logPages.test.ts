import assert from "node:assert/strict"
import test from "node:test"
import type { Provider } from "ethers"
import { getLogPages, LOG_PAGE_SIZE, type LogPage } from "./logPages.js"

const filter = { address: "0x1", fromBlock: 10, toBlock: 10, topics: ["0x2"] }
const log = (index: number) => ({
  blockNumber: 10,
  data: "0x",
  index,
  topics: ["0x2"],
  transactionHash: `0x${index}`,
})
const oversized = () =>
  Object.assign(new Error("Response size exceeds limit"), { code: -32005 })

test("dense cursor pages are consumed before fetching the next page, and checkpoint only at the end", async () => {
  let calls = 0
  let consumed = 0
  const provider = {
    getLogs: async () => {
      throw oversized()
    },
    send: async () => {
      calls++
      if (calls === 2) assert.equal(consumed, LOG_PAGE_SIZE + 1)
      return calls === 1
        ? {
            cursor: "next",
            logs: Array.from({ length: LOG_PAGE_SIZE + 1 }, (_, i) => log(i)),
          }
        : { logs: [log(LOG_PAGE_SIZE + 1)] }
    },
  } as unknown as Provider
  const pages: LogPage[] = []
  for await (const page of getLogPages(provider, filter, 100)) {
    assert.ok(page.logs.length <= LOG_PAGE_SIZE)
    consumed += page.logs.length
    pages.push(page)
  }
  assert.equal(consumed, LOG_PAGE_SIZE + 2)
  assert.deepEqual(
    pages.map((page) => page.complete),
    [false, false, true]
  )
  assert.deepEqual(
    pages.flatMap((page) => page.logs).map((entry) => entry.index),
    Array.from({ length: consumed }, (_, i) => i)
  )
})

test("cursor failure never marks a partially processed block complete", async () => {
  let calls = 0
  const provider = {
    getLogs: async () => {
      throw oversized()
    },
    send: async () => {
      if (++calls === 2) throw new Error("RPC unavailable")
      return { cursor: "next", logs: [log(0)] }
    },
  } as unknown as Provider
  const pages: LogPage[] = []
  await assert.rejects(async () => {
    for await (const page of getLogPages(provider, filter, 100))
      pages.push(page)
  }, /RPC unavailable/)
  assert.equal(pages.length, 1)
  assert.equal(pages[0].complete, false)
})

test("a stalled cursor fails instead of looping", async () => {
  const provider = {
    getLogs: async () => {
      throw oversized()
    },
    send: async () => ({ cursor: "stuck", logs: [] }),
  } as unknown as Provider
  await assert.rejects(async () => {
    for await (const page of getLogPages(provider, filter, 100))
      assert.equal(page.complete, false)
  }, /cursor did not advance/)
})

test("learned ranges survive polls and grow after sustained sparse responses", async () => {
  const calls: Array<[number, number]> = []
  let limit = 2
  const provider = {
    getLogs: async (range: { fromBlock: number; toBlock: number }) => {
      calls.push([range.fromBlock, range.toBlock])
      if (range.toBlock - range.fromBlock + 1 > limit) throw oversized()
      return []
    },
  } as unknown as Provider
  const state = { blockCount: 8, successfulRanges: 0 }
  const read = async (from: number, to: number) => {
    const blocks: number[] = []
    for await (const page of getLogPages(
      provider,
      { ...filter, fromBlock: from, toBlock: to },
      8,
      state
    )) {
      assert.equal(page.complete, true)
      for (let block = page.fromBlock; block <= page.toBlock; block++)
        blocks.push(block)
    }
    assert.deepEqual(
      blocks,
      Array.from({ length: to - from + 1 }, (_, i) => from + i)
    )
  }
  await read(10, 17)
  assert.equal(state.blockCount, 2)
  calls.length = 0
  await read(10, 17)
  assert.ok(calls.every(([from, to]) => to - from + 1 <= 2))
  limit = 8
  await read(18, 280)
  assert.equal(state.blockCount, 8)
})

test("unexpected RPC errors propagate without range splitting", async () => {
  let calls = 0
  const provider = {
    getLogs: async () => {
      calls++
      throw new Error("unauthorized")
    },
  } as unknown as Provider
  await assert.rejects(async () => {
    for await (const page of getLogPages(
      provider,
      { ...filter, toBlock: 100 },
      100
    ))
      assert.fail(JSON.stringify(page))
  }, /unauthorized/)
  assert.equal(calls, 1)
})

for (const [name, error] of [
  [
    "throughput limit",
    { code: -32005, message: "Your app has exceeded its throughput limit" },
  ],
  [
    "nested throughput limit",
    {
      error: {
        code: -32005,
        message: "Your app has exceeded its throughput limit",
      },
    },
  ],
  ["unspecified limit", { code: -32005, message: "Limit exceeded" }],
  ["bare limit code", { error: { code: -32005 } }],
] as const) {
  for (const blockCount of [1, 2000]) {
    test(`${name} propagates without retrying or changing the ${blockCount}-block range`, async () => {
      let logCalls = 0
      let cursorCalls = 0
      const provider = {
        getLogs: async () => {
          logCalls++
          throw error
        },
        send: async () => {
          cursorCalls++
          throw error
        },
      } as unknown as Provider
      const state = { blockCount, successfulRanges: 12 }

      await assert.rejects(
        async () => {
          for await (const page of getLogPages(
            provider,
            { ...filter, toBlock: filter.fromBlock + blockCount - 1 },
            blockCount,
            state
          ))
            assert.fail(JSON.stringify(page))
        },
        (caught: unknown) => caught === error
      )

      assert.equal(logCalls, 1)
      assert.equal(cursorCalls, 0)
      assert.deepEqual(state, { blockCount, successfulRanges: 12 })
    })
  }
}

const collectTransferLogs = async (
  provider: Provider,
  params: {
    address: string
    fromBlock: number
    toBlock: number
    topic: string
  }
) => {
  const logs = []
  for await (const page of getLogPages(
    provider,
    {
      address: params.address,
      fromBlock: params.fromBlock,
      toBlock: params.toBlock,
      topics: [[params.topic]],
    },
    params.toBlock - params.fromBlock + 1
  ))
    logs.push(...page.logs)
  return logs
}

test("getLogPages splits oversized log ranges", async () => {
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

  const logs = await collectTransferLogs(provider, {
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

test("getLogPages uses cursor pagination for oversized single-block ranges", async () => {
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

  const logs = await collectTransferLogs(provider, {
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
