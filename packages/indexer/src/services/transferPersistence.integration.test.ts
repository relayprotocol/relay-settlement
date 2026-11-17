import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { RelayHub } from "@relay-protocol/settlement-abis"
import { Interface, ZeroAddress, type Contract, type Provider } from "ethers"
import PgPromise from "pg-promise"
import {
  ensureToken,
  insertEvent,
  parseTransferLog,
  replayTransferLogFromChain,
  syncTokenTransfersFromEvents,
} from "./transferProcessor.js"
import { getEventKey, getIndexedEventKeys } from "./indexedEvents.js"
import { processTransferLogs } from "./transferBatch.js"
import { runTransferReplay } from "./transferReplay.js"

const databaseUrl = process.env.INDEXER_TEST_DATABASE_URL
const abi = new Interface(RelayHub)
const event = abi.getEvent("Transfer")!
const wallet = "0x0000000000000000000000000000000000000001"
const address = "0x0000000000000000000000000000000000000002"
const makeLog = (index: number, tokenId = 1n, blockNumber = 100) => ({
  ...abi.encodeEventLog(event, [
    ZeroAddress,
    ZeroAddress,
    wallet,
    tokenId,
    10n,
  ]),
  blockNumber,
  index,
  transactionHash: `0x${index.toString(16).padStart(64, "0")}`,
})
const eventInput = (index: number, tokenId = "1") => ({
  amount: "10",
  blockNumber: 100,
  from: ZeroAddress,
  index,
  operator: ZeroAddress,
  timestamp: 1000,
  to: wallet,
  tokenId,
  transactionHash: makeLog(index).transactionHash,
})
const migration = async (name: string) =>
  (
    await readFile(
      new URL(`../migrations/${name}.sql`, import.meta.url),
      "utf8"
    )
  ).split("-- Down Migration")[0]

test(
  "transfer persistence and recovery against PostgreSQL",
  { skip: !databaseUrl },
  async (t) => {
    const pgp = PgPromise()
    const admin = pgp(databaseUrl!)
    const schema = `indexer_test_${randomUUID().replace(/-/g, "")}`
    await admin.none("CREATE SCHEMA $1:name", [schema])
    const scopedUrl = new URL(databaseUrl!)
    scopedUrl.searchParams.set("options", `-c search_path=${schema}`)
    const db = pgp({ connectionString: scopedUrl.toString(), max: 16 })
    t.after(async () => {
      await db.$pool.end()
      await admin.none("DROP SCHEMA $1:name CASCADE", [schema])
      await admin.$pool.end()
    })
    await db.none(await migration("1775600000000_init_indexer"))
    await db.none(await migration("1786953078000_add_token_origin_metadata"))
    await db.none(await migration("1790160000000_add_transfer_stats_minutes"))
    const baseline = await migration("1790110000000_initialize_transfer_counts")
    let failBalance = false
    let balanceReads = 0
    const hub = {
      balanceOf: async () => {
        balanceReads++
        if (failBalance) throw new Error("balance RPC failed")
        return 10n
      },
      decimals: async () => 18,
      name: async () => "Test token",
      symbol: async () => "TEST",
      target: address,
      tokenMetadata: async () => ({
        originAsset: wallet,
        originChainId: 1,
        originFamily: "evm",
      }),
      totalSupply: async () => 10n,
    } as unknown as Contract
    t.beforeEach(async () => {
      failBalance = false
      balanceReads = 0
      await db.none(
        "TRUNCATE events, tokens, balances, failed_events, transfer_stats_minutes, transfer_stats_backfill RESTART IDENTITY"
      )
    })
    const assertCount = async (tokenId: string, expected: number) => {
      const row = await db.one<{ actual: number; transfers: number }>(
        "SELECT transfers, (SELECT COUNT(*)::int FROM events WHERE token_id=$1) actual FROM tokens WHERE token_id=$1",
        [tokenId]
      )
      assert.deepEqual(row, { actual: expected, transfers: expected })
    }
    const legacyEvent = async (index: number, tokenId: string) => {
      const log = eventInput(index, tokenId)
      await db.none(
        `INSERT INTO events(block_number, tx_hash, log_index, operator, from_addr, to_addr, token_id, amount, timestamp)
      VALUES($/blockNumber/, $/transactionHash/, $/index/, $/operator/, $/from/, $/to/, $/tokenId/, $/amount/, $/timestamp/)`,
        log
      )
    }

    await t.test(
      "migration resets stale counts, including tokens without events",
      async () => {
        await ensureToken(db, hub, "1")
        await ensureToken(db, hub, "2")
        await legacyEvent(1, "1")
        await legacyEvent(2, "1")
        await db.none("UPDATE tokens SET transfers=42")
        await db.tx((tx) => tx.none(baseline))
        await assertCount("1", 2)
        await assertCount("2", 0)
        await insertEvent(db, eventInput(3))
        await assertCount("1", 3)
      }
    )

    await t.test(
      "batched identity lookup handles RPC hex casing without matching unrelated logs",
      async () => {
        await ensureToken(db, hub, "1")
        const input = eventInput(171)
        input.transactionHash =
          "0x" + input.transactionHash.slice(2).toUpperCase()
        await insertEvent(db, input)
        const log = makeLog(171)
        const unrelated = {
          ...log,
          transactionHash: makeLog(172).transactionHash,
        }
        const keys = await getIndexedEventKeys(db, [log, unrelated])
        assert.deepEqual([...keys], [getEventKey(log)])
      }
    )

    await t.test(
      "first event creates metadata and duplicates do not increment",
      async () => {
        const log = makeLog(1)
        const transfer = parseTransferLog(log)!
        assert.equal(
          (await replayTransferLogFromChain(db, hub, transfer, log, 1000))
            .inserted,
          1
        )
        assert.equal(
          (await replayTransferLogFromChain(db, hub, transfer, log, 1000))
            .inserted,
          0
        )
        await assertCount("1", 1)
        assert.equal(
          (await db.one("SELECT name FROM tokens WHERE token_id='1'")).name,
          "Test token"
        )
      }
    )

    await t.test(
      "metadata initialization includes legacy orphan events once",
      async () => {
        await legacyEvent(1, "1")
        await ensureToken(db, hub, "1")
        await insertEvent(db, eventInput(2))
        await assertCount("1", 2)
      }
    )

    await t.test(
      "missing metadata, rollback and counter errors cannot commit an uncounted event",
      async () => {
        await assert.rejects(insertEvent(db, eventInput(1)), /must exist/)
        assert.equal((await db.one("SELECT COUNT(*)::int n FROM events")).n, 0)
        await assert.rejects(
          db.tx(async (tx) => {
            await ensureToken(tx, hub, "1")
            await insertEvent(tx, eventInput(1))
            throw new Error("crash before commit")
          }),
          /crash before commit/
        )
        assert.equal((await db.one("SELECT COUNT(*)::int n FROM tokens")).n, 0)
        assert.equal((await db.one("SELECT COUNT(*)::int n FROM events")).n, 0)
        await ensureToken(db, hub, "1")
        await db.none("UPDATE tokens SET transfers=2147483647")
        await assert.rejects(insertEvent(db, eventInput(1)), /out of range/)
        assert.equal((await db.one("SELECT COUNT(*)::int n FROM events")).n, 0)
      }
    )

    await t.test(
      "concurrent inserts, duplicates and count repairs retain exact counts",
      async () => {
        await ensureToken(db, hub, "1")
        const results = await Promise.all(
          Array.from({ length: 500 }, (_, i) =>
            insertEvent(db, eventInput(i % 250))
          )
        )
        assert.equal(
          results.reduce((a, b) => a + b, 0),
          250
        )
        await assertCount("1", 250)
        await Promise.all(
          Array.from({ length: 30 }, (_, i) =>
            i % 2 === 0
              ? syncTokenTransfersFromEvents(db, "1")
              : insertEvent(db, eventInput(250 + i))
          )
        )
        await assertCount("1", 265)
      }
    )

    await t.test(
      "repair waits for an in-flight insert before counting its committed event",
      async () => {
        await ensureToken(db, hub, "1")
        const repairUrl = new URL(scopedUrl)
        repairUrl.searchParams.set("application_name", schema)
        const repairDb = pgp({ connectionString: repairUrl.toString(), max: 1 })
        let inserted!: () => void
        let release!: () => void
        const ready = new Promise<void>((resolve) => {
          inserted = resolve
        })
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        const writing = db.tx(async (tx) => {
          await insertEvent(tx, eventInput(1))
          inserted()
          await gate
        })
        await ready
        const repairing = syncTokenTransfersFromEvents(repairDb, "1")
        try {
          const deadline = Date.now() + 5000
          let waiting = false
          while (!waiting && Date.now() < deadline) {
            const row = await db.one<{ waiting: boolean }>(
              "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') waiting",
              [schema]
            )
            waiting = row.waiting
            if (!waiting) await new Promise((resolve) => setTimeout(resolve, 5))
          }
          assert.ok(waiting, "repair should wait for the token writer")
        } finally {
          release()
          await Promise.all([writing, repairing])
          await repairDb.$pool.end()
        }
        await assertCount("1", 1)
      }
    )

    await t.test(
      "concurrent first-token creation preserves metadata and all increments",
      async () => {
        await Promise.all(
          Array.from({ length: 30 }, async (_, i) => {
            await ensureToken(db, hub, "1")
            return insertEvent(db, eventInput(i))
          })
        )
        await assertCount("1", 30)
        assert.equal(
          (await db.one("SELECT name FROM tokens")).name,
          "Test token"
        )
      }
    )

    await t.test(
      "retry repairs state after an event committed before reconciliation failed",
      async () => {
        const log = makeLog(1)
        failBalance = true
        await assert.rejects(
          replayTransferLogFromChain(
            db,
            hub,
            parseTransferLog(log)!,
            log,
            1000
          ),
          /balance RPC failed/
        )
        await assertCount("1", 1)
        assert.equal(
          (await db.one("SELECT COUNT(*)::int n FROM balances")).n,
          0
        )
        failBalance = false
        const result = await replayTransferLogFromChain(
          db,
          hub,
          parseTransferLog(log)!,
          log,
          1000
        )
        assert.equal(result.inserted, 0)
        await assertCount("1", 1)
        assert.equal(
          (await db.one("SELECT balance FROM balances")).balance,
          "10"
        )
      }
    )

    await t.test(
      "live overlap skips committed duplicates but repairs missing and above-checkpoint events",
      async () => {
        const old = makeLog(1),
          missing = makeLog(2)
        await ensureToken(db, hub, "1")
        await insertEvent(db, eventInput(1))
        const timestamps: number[] = []
        const options = {
          checkpoint: 100,
          contractAddress: address,
          getTimestamp: async (block: number) => {
            timestamps.push(block)
            return 1000
          },
          lane: "hub-transfers",
        }
        await processTransferLogs(db, hub, [old], options)
        assert.equal(timestamps.length, 0)
        assert.equal(balanceReads, 0)
        await processTransferLogs(db, hub, [old, missing], options)
        assert.equal(timestamps.length, 1)
        await assertCount("1", 2)
        await db.none("DELETE FROM balances")
        await processTransferLogs(db, hub, [old], {
          ...options,
          checkpoint: 99,
        })
        assert.equal(
          (await db.one("SELECT balance FROM balances")).balance,
          "10"
        )
        await assertCount("1", 2)
      }
    )

    await t.test(
      "live reconciliation failures retain failed_events after an atomic insert",
      async () => {
        const log = makeLog(1)
        failBalance = true
        await processTransferLogs(db, hub, [log], {
          checkpoint: 99,
          contractAddress: address,
          getTimestamp: async () => 1000,
          lane: "hub-transfers",
        })
        await assertCount("1", 1)
        assert.equal(
          (await db.one("SELECT COUNT(*)::int n FROM failed_events")).n,
          1
        )
      }
    )

    await t.test(
      "manual replay streams dense pages and preserves state repair on duplicate replay",
      async () => {
        let pageCalls = 0
        const progress: Array<number | null> = []
        const provider = {
          getBlock: async () => ({ timestamp: 1000 }),
          getLogs: async () => {
            throw Object.assign(new Error("Response size exceeds limit"), {
              code: -32005,
            })
          },
          send: async () => {
            pageCalls++
            if (pageCalls === 2) {
              assert.ok(progress.every((block) => block === null))
              await assertCount("1", 1001)
            }
            return pageCalls % 2 === 1
              ? {
                  cursor: "next",
                  logs: Array.from({ length: 1001 }, (_, i) => makeLog(i)),
                }
              : { logs: [makeLog(1001)] }
          },
        } as unknown as Provider
        const request = {
          batchSize: 100,
          fromBlock: 100,
          reconcileChunkSize: 100,
          toBlock: 100,
        }
        const result = await runTransferReplay(db, provider, hub, request, {
          onProgress: (p) => {
            progress.push(p.currentBlock)
          },
        })
        assert.equal(result.currentBlock, 100)
        assert.equal(result.inserted, 1002)
        await assertCount("1", 1002)
        await db.none("DELETE FROM balances")
        const retry = await runTransferReplay(db, provider, hub, request)
        assert.equal(retry.inserted, 0)
        assert.equal(
          (await db.one("SELECT balance FROM balances")).balance,
          "10"
        )
        await assertCount("1", 1002)
      }
    )
  }
)
