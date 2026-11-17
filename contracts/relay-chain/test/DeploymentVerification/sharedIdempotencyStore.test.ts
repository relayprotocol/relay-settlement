import { beforeEach, describe, expect, it, vi } from "vitest"
import { keccak256, toHex, type PublicClient } from "viem"

import { getRoleGrantedLogsPaginated } from "../../deployments/scripts/misc/verify-deployment/helpers"
import {
  discoverRoleHolders,
  type Ctx,
} from "../../deployments/scripts/misc/verify-deployment/steps"

vi.mock(
  "../../deployments/scripts/misc/verify-deployment/helpers",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../deployments/scripts/misc/verify-deployment/helpers")
    >()),
    getRoleGrantedLogsPaginated: vi.fn(),
  })
)

const store = `0x${"11".repeat(20)}`
const inbox = `0x${"22".repeat(20)}`
const previousOracle = `0x${"33".repeat(20)}`
const otherStore = `0x${"44".repeat(20)}`
const WRITE_ROLE = keccak256(toHex("WRITE_ROLE"))
const ADMIN_ROLE = keccak256(toHex("ADMIN_ROLE"))

let previousOracleStore: string
const readContract = vi.fn()
let lines: string[]

const ctx = (previousOracles?: string[]): Ctx =>
  ({
    castFixes: [],
    client: { readContract } as unknown as PublicClient,
    deployment: { oracle: inbox, oracleIdempotencyStore: store },
    env: "dev",
    expectedRoles: [],
    idempotencyStoreKey: "oracleIdempotencyStore",
    previousOracles,
    printCast: false,
  }) as unknown as Ctx

const grants = (...roles: [string, string][]) =>
  vi.mocked(getRoleGrantedLogsPaginated).mockResolvedValue(
    roles.map(([role, account]) => ({
      address: store,
      args: { account, role },
    })) as never
  )

beforeEach(() => {
  previousOracleStore = store
  readContract.mockReset()
  readContract.mockImplementation(async ({ functionName }) =>
    functionName === "IDEMPOTENCY_STORE" ? previousOracleStore : true
  )
  lines = []
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    lines.push(line)
  })
})

describe("role holder discovery on a shared idempotency store", () => {
  it("reports the previous oracle's WRITE_ROLE as expected", async () => {
    grants([WRITE_ROLE, previousOracle])
    expect(await discoverRoleHolders(ctx([previousOracle]))).toBe(0)
    expect(lines.join("\n")).toContain(
      `held by ${previousOracle}: previous oracle (shared store, retired at cutover)`
    )
  })

  it("checks the previous oracle even without historical logs", async () => {
    grants()
    expect(await discoverRoleHolders(ctx([previousOracle]))).toBe(0)
    expect(lines.join("\n")).toContain("previous oracle (shared store")
  })

  it("still flags it when no previous oracle is declared", async () => {
    grants([WRITE_ROLE, previousOracle])
    expect(await discoverRoleHolders(ctx())).toBe(1)
    expect(lines.join("\n")).toContain(
      `held by undeclared address ${previousOracle}`
    )
  })

  it("still flags a previous oracle that points at another store", async () => {
    previousOracleStore = otherStore
    grants([WRITE_ROLE, previousOracle])
    expect(await discoverRoleHolders(ctx([previousOracle]))).toBe(1)
    expect(lines.join("\n")).toContain(
      `previous oracle, but its IDEMPOTENCY_STORE() is ${otherStore}`
    )
  })

  it("still flags any other role the previous oracle holds", async () => {
    grants([ADMIN_ROLE, previousOracle])
    expect(await discoverRoleHolders(ctx([previousOracle]))).toBe(1)
    expect(lines.join("\n")).toMatch(
      /ADMIN_ROLE held by undeclared address 0x3333/
    )
  })
})
