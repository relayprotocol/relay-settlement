import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Hex } from "viem"

import { ACCESS_CONTROL_LOG_PAGE_SIZE } from "../../deployments/scripts/misc/verify-deployment/constants"
import type { RoleGrantedLog } from "../../deployments/scripts/misc/verify-deployment/constants"
import { getRoleGrantedLogsPaginated } from "../../deployments/scripts/misc/verify-deployment/helpers"

const hash = `0x${"ab".repeat(32)}` as Hex
const replacementHash = `0x${"cd".repeat(32)}` as Hex
const log: RoleGrantedLog = {
  address: `0x${"11".repeat(20)}`,
  args: { account: `0x${"33".repeat(20)}`, role: `0x${"22".repeat(32)}` },
}

function mockClient(latestBlock = 10n) {
  return {
    getBlock: vi.fn(async (_filter: { blockNumber: bigint }) => ({ hash })),
    getBlockNumber: vi.fn(async () => latestBlock),
    getChainId: vi.fn(async () => 1),
    getLogs: vi.fn(async (_filter: { fromBlock: bigint; toBlock: bigint }) => [
      { ...log, blockNumber: 1n },
    ]),
  }
}

describe("RoleGranted log cache", () => {
  let directory: string
  const cachePath = () => join(directory, "role-granted-1.json")

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "verify-deployment-"))
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
  })

  afterEach(() => {
    rmSync(directory, { force: true, recursive: true })
    vi.restoreAllMocks()
  })

  it("persists discovery fields and avoids log calls at an unchanged head", async () => {
    await getRoleGrantedLogsPaginated(mockClient(), directory)
    expect(JSON.parse(readFileSync(cachePath(), "utf8"))).toMatchObject({
      blockHash: hash,
      logs: [log],
      toBlock: "10",
    })

    const nextRun = mockClient()
    await expect(
      getRoleGrantedLogsPaginated(nextRun, directory)
    ).resolves.toEqual([log])
    expect(nextRun.getLogs).not.toHaveBeenCalled()
    expect(nextRun.getBlock).toHaveBeenCalledWith({ blockNumber: 10n })
  })

  it("fetches only new blocks and preserves cached logs", async () => {
    await getRoleGrantedLogsPaginated(mockClient(), directory)
    const nextRun = mockClient(15n)
    nextRun.getLogs.mockResolvedValue([])
    await expect(
      getRoleGrantedLogsPaginated(nextRun, directory)
    ).resolves.toEqual([log])
    expect(nextRun.getLogs).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ fromBlock: 11n, toBlock: 15n })
    )
    expect(JSON.parse(readFileSync(cachePath(), "utf8")).toBlock).toBe("15")
  })

  it("caches empty ranges", async () => {
    const client = mockClient()
    client.getLogs.mockResolvedValue([])
    await getRoleGrantedLogsPaginated(client, directory)
    client.getLogs.mockClear()
    await expect(
      getRoleGrantedLogsPaginated(client, directory)
    ).resolves.toEqual([])
    expect(client.getLogs).not.toHaveBeenCalled()
  })

  it("resumes after the last completed page when a later page fails", async () => {
    const client = mockClient(ACCESS_CONTROL_LOG_PAGE_SIZE)
    client.getLogs.mockImplementation(async ({ fromBlock }) => {
      if (fromBlock === ACCESS_CONTROL_LOG_PAGE_SIZE) {
        throw new Error("RPC unavailable")
      }
      return [{ ...log, blockNumber: 1n }]
    })
    await expect(
      getRoleGrantedLogsPaginated(client, directory)
    ).rejects.toThrow("RPC unavailable")

    const nextRun = mockClient(ACCESS_CONTROL_LOG_PAGE_SIZE)
    nextRun.getLogs.mockResolvedValue([])
    await expect(
      getRoleGrantedLogsPaginated(nextRun, directory)
    ).resolves.toEqual([log])
    expect(nextRun.getLogs).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        fromBlock: ACCESS_CONTROL_LOG_PAGE_SIZE,
        toBlock: ACCESS_CONTROL_LOG_PAGE_SIZE,
      })
    )
  })

  it.each(["reorg", "reset", "different chain"])(
    "rescans after a %s",
    async (change) => {
      await getRoleGrantedLogsPaginated(mockClient(), directory)
      const nextRun = mockClient(change === "reset" ? 5n : 10n)
      if (change === "reorg")
        nextRun.getBlock.mockResolvedValue({ hash: replacementHash })
      if (change === "different chain") nextRun.getChainId.mockResolvedValue(2)
      nextRun.getLogs.mockResolvedValue([])
      await expect(
        getRoleGrantedLogsPaginated(nextRun, directory)
      ).resolves.toEqual([])
      expect(nextRun.getLogs).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ fromBlock: 0n })
      )
    }
  )

  it("does not advance the cache when history changes during a scan", async () => {
    await getRoleGrantedLogsPaginated(mockClient(), directory)
    const nextRun = mockClient(15n)
    nextRun.getLogs.mockImplementation(async () => {
      nextRun.getBlock.mockResolvedValue({ hash: replacementHash })
      return []
    })
    await expect(
      getRoleGrantedLogsPaginated(nextRun, directory)
    ).rejects.toThrow("Chain history changed")
    expect(JSON.parse(readFileSync(cachePath(), "utf8")).toBlock).toBe("10")
  })

  it.each(["{broken", '{"version":1}', '{"version":0}'])(
    "ignores invalid cache data: %s",
    async (data) => {
      writeFileSync(cachePath(), data)
      const client = mockClient()
      await getRoleGrantedLogsPaginated(client, directory)
      expect(client.getLogs).toHaveBeenCalledOnce()
      expect(console.warn).toHaveBeenCalled()
    }
  )

  it("continues verification if the cache cannot be written", async () => {
    const file = join(directory, "not-a-directory")
    writeFileSync(file, "")
    const client = mockClient()
    await expect(
      getRoleGrantedLogsPaginated(client, file)
    ).resolves.toMatchObject([log])
    expect(client.getLogs).toHaveBeenCalledOnce()
    expect(console.warn).toHaveBeenCalled()
  })
})
