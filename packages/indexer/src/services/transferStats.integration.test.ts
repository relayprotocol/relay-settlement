import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { setTimeout } from "node:timers/promises"
import test from "node:test"
import PgPromise from "pg-promise"
import { insertEvent } from "./transferProcessor.js"
import {
  backfillTransferStatsBatch,
  repairTransferStatsMinutes,
  resetTransferStatsBackfill,
  withTransferStatsBackfillLock,
} from "./transferStatsBackfill.js"
import { queryTransferStats } from "../queries/events.js"

const databaseUrl = process.env.INDEXER_TEST_DATABASE_URL
const event = (id: number, timestamp = 1000, tokenId = "1") => ({
  amount: "1",
  blockNumber: 10,
  from: "0x01",
  index: id,
  operator: "0x01",
  timestamp,
  to: "0x02",
  tokenId,
  transactionHash: `tx-${id}`,
})

test(
  "transfer statistics against PostgreSQL",
  { skip: !databaseUrl },
  async (t) => {
    const pgp = PgPromise()
    const admin = pgp(databaseUrl!)
    const schema = `stats_test_${randomUUID().replace(/-/g, "")}`
    await admin.none("CREATE SCHEMA $1:name", [schema])
    const url = new URL(databaseUrl!)
    url.searchParams.set("options", `-c search_path=${schema}`)
    const db = pgp({
      application_name: schema,
      connectionString: url.toString(),
      max: 16,
    })
    t.after(async () => {
      await db.$pool.end()
      await admin.none("DROP SCHEMA $1:name CASCADE", [schema])
      await admin.$pool.end()
    })
    for (const name of [
      "1775600000000_init_indexer",
      "1790160000000_add_transfer_stats_minutes",
    ]) {
      await db.none(
        (
          await readFile(
            new URL(`../migrations/${name}.sql`, import.meta.url),
            "utf8"
          )
        ).split("-- Down Migration")[0]!
      )
    }
    t.beforeEach(async () => {
      await db.none(
        "TRUNCATE events, tokens, transfer_stats_minutes, transfer_stats_backfill RESTART IDENTITY"
      )
      await db.none(
        "INSERT INTO tokens(token_id, total_supply) VALUES('1',0),('2',0)"
      )
    })
    const legacy = async (id: number, timestamp: number, tokenId = "1") =>
      db.none(
        `INSERT INTO events(block_number,tx_hash,log_index,operator,from_addr,to_addr,token_id,amount,timestamp)
     VALUES(10,$1,$2,'0x01','0x01','0x02',$3,1,$4)`,
        [`tx-${id}`, id, tokenId, timestamp]
      )
    const finish = async (batchSize = 100) => {
      for (let i = 0; i < 100; i++)
        if ((await backfillTransferStatsBatch(db, batchSize)).complete) return
      throw new Error("Backfill did not finish")
    }
    const assertSummaries = async () => {
      const mismatches = await db.any(`WITH expected AS (
      SELECT token_id, FLOOR(timestamp::numeric/60)::bigint*60 minute_start, COUNT(*) transfers
      FROM events GROUP BY token_id, minute_start
    ) SELECT * FROM expected e FULL JOIN transfer_stats_minutes s USING(token_id,minute_start)
      WHERE COALESCE(e.transfers,0) <> COALESCE(s.transfers,0)`)
      assert.deepEqual(mismatches, [])
    }
    const waitForLock = async () => {
      for (let i = 0; i < 100; i++) {
        const row = await admin.one(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') waiting",
          [schema]
        )
        if (row.waiting) return
        await setTimeout(10)
      }
      assert.fail("Expected a transaction waiting on the summary row lock")
    }

    await t.test(
      "backfill and reset exclude each other and release their lock after failure",
      async () => {
        await assert.rejects(
          withTransferStatsBackfillLock(db, async (task) => {
            await backfillTransferStatsBatch(task)
            await assert.rejects(
              withTransferStatsBackfillLock(db, resetTransferStatsBackfill),
              /already running|is running/
            )
            assert.ok(
              (
                await task.one(
                  "SELECT completed_at FROM transfer_stats_backfill"
                )
              ).completed_at
            )
            throw new Error("interrupted")
          }),
          /interrupted/
        )
        await withTransferStatsBackfillLock(db, resetTransferStatsBackfill)
        assert.equal(
          (
            await db.one(
              "SELECT COUNT(*)::int count FROM transfer_stats_backfill"
            )
          ).count,
          0
        )
      }
    )

    await t.test(
      "duplicates, rollback, historical replay and concurrent inserts maintain exact counts",
      async () => {
        await Promise.all(
          Array.from({ length: 100 }, (_, i) =>
            insertEvent(db, event(i % 50, 1000 + (i % 50)))
          )
        )
        await assert.rejects(
          db.tx(async (tx) => {
            await insertEvent(tx, event(100))
            throw new Error("rollback")
          }),
          /rollback/
        )
        await finish()
        await insertEvent(db, event(101, 100))
        await insertEvent(db, event(101, 100))
        await assertSummaries()
        assert.equal(
          Number((await db.one("SELECT COUNT(*) FROM events")).count),
          51
        )
      }
    )

    await t.test(
      "minute count failures roll back the event and token counter",
      async () => {
        await insertEvent(db, event(1))
        await db.none(
          "UPDATE transfer_stats_minutes SET transfers=9223372036854775807"
        )
        await assert.rejects(insertEvent(db, event(2)), /out of range/)
        assert.equal(
          Number((await db.one("SELECT COUNT(*) FROM events")).count),
          1
        )
        assert.equal(
          (await db.one("SELECT transfers FROM tokens WHERE token_id='1'"))
            .transfers,
          1
        )
      }
    )

    await t.test(
      "resumable backfill replaces partial counts and gates reads until complete",
      async () => {
        await legacy(1, 1000)
        await legacy(2, 1060, "2")
        await insertEvent(db, event(3, 1061, "2"))
        const first = await backfillTransferStatsBatch(db, 1)
        assert.equal(first.complete, false)
        const args = {
          granularity: "day" as const,
          since: 0,
          tzOffsetMinutes: 0,
        }
        const before = await queryTransferStats(db, args)
        assert.equal(before[0]?.count, 3)
        // New writers can replay events before the backfill's original bounds.
        await insertEvent(db, event(5, 100))
        await finish(1)
        assert.equal((await queryTransferStats(db, args))[0]?.count, 4)
        await assertSummaries()
        assert.equal((await backfillTransferStatsBatch(db)).repaired, 0)
        await resetTransferStatsBackfill(db)
        await legacy(4, 1062)
        assert.equal((await queryTransferStats(db, args))[0]?.count, 5)
        await finish()
        await assertSummaries()
      }
    )

    await t.test(
      "reset and backfill remove deleted or moved keys beyond the remaining event range",
      async () => {
        await insertEvent(db, event(1, 60))
        await insertEvent(db, event(2, 3000))
        await insertEvent(db, event(3, 6000))
        await finish()
        await resetTransferStatsBackfill(db)
        await db.none("DELETE FROM events WHERE log_index IN (1,3)")
        await db.none(
          "UPDATE events SET token_id='2', timestamp=3600 WHERE log_index=2"
        )
        const args = {
          granularity: "minute" as const,
          since: 0,
          tzOffsetMinutes: 0,
        }
        const expected = await queryTransferStats(db, args)
        await finish(1)
        await assertSummaries()
        assert.deepEqual(await queryTransferStats(db, args), expected)
        const summaries = await db.any(
          "SELECT token_id, minute_start::int, transfers::int FROM transfer_stats_minutes"
        )
        assert.deepEqual(summaries, [
          { minute_start: 3600, token_id: "2", transfers: 1 },
        ])
        await resetTransferStatsBackfill(db)
        await db.none("DELETE FROM events")
        await finish(1)
        assert.deepEqual(
          await db.any("SELECT * FROM transfer_stats_minutes"),
          []
        )
        assert.deepEqual(await queryTransferStats(db, args), [])
      }
    )

    await t.test(
      "backfill takes a fresh snapshot after waiting for a writer",
      async () => {
        await legacy(1, 1000)
        let unlock: () => void = () => undefined
        let acquired: () => void = () => undefined
        const gate = new Promise<void>((r) => {
          unlock = r
        })
        const ready = new Promise<void>((r) => {
          acquired = r
        })
        const writer = db.tx(async (tx) => {
          await insertEvent(tx, event(2))
          acquired()
          await gate
        })
        await ready
        const backfill = backfillTransferStatsBatch(db)
        try {
          await waitForLock()
        } finally {
          unlock()
        }
        await writer
        await backfill
        await finish()
        await assertSummaries()
      }
    )

    await t.test(
      "an insert waiting on repair increments the repaired baseline exactly once",
      async () => {
        await legacy(1, 1000)
        let unlock: () => void = () => undefined
        let acquired: () => void = () => undefined
        const gate = new Promise<void>((r) => {
          unlock = r
        })
        const ready = new Promise<void>((r) => {
          acquired = r
        })
        const repair = db.tx(async (tx) => {
          await repairTransferStatsMinutes(tx, [
            { minute_start: 960, token_id: "1" },
          ])
          acquired()
          await gate
        })
        await ready
        const writer = insertEvent(db, event(2))
        try {
          await waitForLock()
        } finally {
          unlock()
        }
        await Promise.all([repair, writer])
        await assertSummaries()
      }
    )

    await t.test(
      "an insert waiting on orphan cleanup recreates its summary exactly once",
      async () => {
        await insertEvent(db, event(1))
        await db.none("DELETE FROM events")
        let unlock: () => void = () => undefined
        let acquired: () => void = () => undefined
        const gate = new Promise<void>((r) => {
          unlock = r
        })
        const ready = new Promise<void>((r) => {
          acquired = r
        })
        const repair = db.tx(async (tx) => {
          await repairTransferStatsMinutes(tx, [
            { minute_start: 960, token_id: "1" },
          ])
          acquired()
          await gate
        })
        await ready
        const writer = insertEvent(db, event(2))
        try {
          await waitForLock()
        } finally {
          unlock()
        }
        await Promise.all([repair, writer])
        await assertSummaries()
        assert.equal(
          Number(
            (await db.one("SELECT transfers FROM transfer_stats_minutes"))
              .transfers
          ),
          1
        )
      }
    )

    await t.test(
      "summary and raw queries match all granularities, offsets and boundary cutoffs",
      async () => {
        await db.none(`INSERT INTO events(block_number,tx_hash,log_index,operator,from_addr,to_addr,token_id,amount,timestamp)
      SELECT 1, anchor::text, i, 'a','a','b', CASE WHEN i%3=0 THEN '1' ELSE '2' END,1,
        EXTRACT(EPOCH FROM anchor)::bigint+i
      FROM unnest(ARRAY[TIMESTAMPTZ '2024-02-29 00:00:00+00',TIMESTAMPTZ '2024-03-01 00:00:00+00',
        TIMESTAMPTZ '2024-12-30 00:00:00+00',TIMESTAMPTZ '2025-01-01 00:00:00+00']) anchor
      CROSS JOIN generate_series(-61,61) i`)
        await db.none(`INSERT INTO transfer_stats_minutes SELECT token_id,FLOOR(timestamp::numeric/60)::bigint*60,COUNT(*)
      FROM events GROUP BY token_id,FLOOR(timestamp::numeric/60)::bigint*60`)
        const formats = {
          day: "YYYY-MM-DD",
          hour: "YYYY-MM-DD HH24:00",
          minute: "YYYY-MM-DD HH24:MI",
          month: "YYYY-MM",
          week: "YYYY-MM-DD",
        }
        for (const ready of [false, true]) {
          if (ready)
            await db.none(
              "INSERT INTO transfer_stats_backfill(id,next_timestamp,end_timestamp,completed_at) VALUES(1,0,0,NOW())"
            )
          for (const granularity of Object.keys(formats) as Array<
            keyof typeof formats
          >) {
            for (const offset of [-720, -210, 0, 330, 345, 840]) {
              for (const tokenId of [undefined, "1"]) {
                for (const since of [
                  1709164800, 1709164817, 1709164817.5, 1736000000,
                ]) {
                  const expected = await db.any(
                    `SELECT to_char(date_trunc('${granularity}',to_timestamp(timestamp) AT TIME ZONE 'UTC'+make_interval(mins=>$1)),'${formats[granularity]}') bucket,
                COUNT(*)::int count FROM events WHERE timestamp >= $2 ${tokenId ? "AND token_id=$3" : ""} GROUP BY bucket ORDER BY bucket`,
                    [offset, since, tokenId]
                  )
                  const actual = await queryTransferStats(db, {
                    granularity,
                    since,
                    tokenId,
                    tzOffsetMinutes: offset,
                  })
                  assert.deepEqual(
                    actual,
                    expected,
                    JSON.stringify({
                      granularity,
                      offset,
                      ready,
                      since,
                      tokenId,
                    })
                  )
                }
              }
            }
          }
        }
        // Explain the actual application query: readiness must prune the full
        // events scan rather than merely filter it after reading history.
        type Plan = { Plans?: Plan[]; Alias?: string; "Actual Loops": number }
        const plans: Plan[] = []
        const explainingDb = Object.create(db) as typeof db
        explainingDb.manyOrNone = async (query, values) => {
          const rows = await db.any(
            `EXPLAIN (ANALYZE, FORMAT JSON) ${query}`,
            values
          )
          const visit = (plan: Plan) => {
            plans.push(plan)
            plan.Plans?.forEach(visit)
          }
          visit(rows[0]["QUERY PLAN"][0].Plan)
          return []
        }
        await queryTransferStats(explainingDb, {
          granularity: "day",
          since: 1709164800,
          tzOffsetMinutes: 0,
        })
        const rawScans = plans.filter((plan) => plan.Alias === "events")
        assert.ok(rawScans.length > 0)
        assert.ok(rawScans.every((plan) => plan["Actual Loops"] === 0))
      }
    )
  }
)
