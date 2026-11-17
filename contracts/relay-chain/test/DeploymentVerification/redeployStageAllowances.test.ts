import { beforeEach, describe, expect, it, vi } from "vitest"
import { bytesToHex, keccak256, toHex, type PublicClient } from "viem"
import { encodeAddress } from "@relay-protocol/settlement-sdk"

import { EXPECTED_ROLES } from "../../deployments/scripts/misc/verify-deployment/constants"
import { getRoleGrantedLogsPaginated } from "../../deployments/scripts/misc/verify-deployment/helpers"
import {
  checkAddressConsistency,
  checkPayloadBuilders,
  checkRoleWiring,
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

// The verifier's Hub-chain redeploy stage allowances (PREVIOUS_CONTRACTS,
// PENDING_HUB_GRANTS, DEFERRED_BUILDER_VM_TYPES): each expected gap is ℹ️,
// everything else still fails.

const addr = (byte: string) => `0x${byte.repeat(20)}`
const deployment = {
  allocator: addr("a1"),
  executor: addr("a2"),
  genericMapping: addr("a3"),
  hub: addr("a4"),
  oracle: addr("a5"),
  oracleMultisig: addr("a6"),
  ethereumVmPayloadBuilder: addr("b1"),
  tonVmPayloadBuilder: addr("b2"),
}
const previousAllocator = addr("c1")
const OPERATOR_ROLE = keccak256(toHex("OPERATOR_ROLE"))
const ADMIN_ROLE = keccak256(toHex("ADMIN_ROLE"))

// hasRole answers: granted unless listed as `${contract}:${role}:${holder}`
let missingRoles: Set<string>
// payloadBuilders answers, keyed `${chainId}:${encoded depository}`
let registrations: Record<string, string>
const readContract = vi.fn()
let lines: string[]

const ctx = (stage: Partial<Ctx> = {}, chains: unknown[] = []): Ctx =>
  ({
    allocator: deployment.allocator,
    castFixes: [],
    chains,
    client: { readContract } as unknown as PublicClient,
    deployment,
    env: "dev",
    expectedRoles: EXPECTED_ROLES,
    grantRoleFix: () => "",
    printCast: false,
    ...stage,
  }) as unknown as Ctx

const encoded = (vmType: string, depository: string) =>
  bytesToHex(encodeAddress(depository, vmType as never))

beforeEach(() => {
  missingRoles = new Set()
  registrations = {}
  readContract.mockReset()
  readContract.mockImplementation(async ({ address, args, functionName }) => {
    if (functionName === "hasRole") {
      const contract = Object.entries(deployment).find(
        ([, value]) => value === address
      )?.[0]
      const role = ["OPERATOR_ROLE", "ORACLE_ROLE"].find(
        (name) => keccak256(toHex(name)) === args[0]
      )
      return !missingRoles.has(`${contract}:${role}:${args[1]}`)
    }
    if (functionName === "payloadBuilders")
      return registrations[`${args[0]}:${args[1]}`] ?? addr("00")
    throw new Error(`unexpected read ${functionName}`)
  })
  lines = []
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    lines.push(line)
  })
})

describe("verify-deployment redeploy stage allowances", () => {
  it("allows the new contracts' Hub grants only while manifest-activate is pending", async () => {
    missingRoles.add(`hub:OPERATOR_ROLE:${deployment.allocator}`)
    expect(await checkRoleWiring(ctx({ pendingActivation: true }))).toBe(0)
    expect(lines.join("\n")).toMatch(/pending manifest-activate/)
    // After activation the same gap is a real failure again
    expect(await checkRoleWiring(ctx())).toBe(1)
  })

  it("still fails an unrelated missing role while manifest-activate is pending", async () => {
    missingRoles.add(`oracle:ORACLE_ROLE:${deployment.oracleMultisig}`)
    expect(await checkRoleWiring(ctx({ pendingActivation: true }))).toBe(1)
  })

  it("allows exactly the grant manifest-cutover revokes, and nothing else", async () => {
    vi.mocked(getRoleGrantedLogsPaginated).mockResolvedValue([
      {
        address: deployment.hub,
        args: { account: previousAllocator, role: OPERATOR_ROLE },
      },
    ] as never)
    const stage = {
      previousRoleGrants: new Set([
        `hub:${OPERATOR_ROLE}:${previousAllocator}`,
      ]),
    } as Partial<Ctx>
    expect(await discoverRoleHolders(ctx(stage))).toBe(0)
    expect(lines.join("\n")).toMatch(/previous set, revoked at cutover/)
    // Another previous contract holding the same role is not covered
    vi.mocked(getRoleGrantedLogsPaginated).mockResolvedValue([
      {
        address: deployment.hub,
        args: { account: addr("c2"), role: OPERATOR_ROLE },
      },
    ] as never)
    expect(await discoverRoleHolders(ctx(stage))).toBe(1)
    vi.mocked(getRoleGrantedLogsPaginated).mockResolvedValue([
      {
        address: deployment.hub,
        args: { account: previousAllocator, role: ADMIN_ROLE },
      },
    ] as never)
    expect(await discoverRoleHolders(ctx(stage))).toBe(1)
  })

  it("defers a missing TON registration, but not a non-deferred one", async () => {
    const chains = [
      { id: "ton", vmType: "ton-vm", depository: `0:${"f3".repeat(32)}` },
      { id: "ethereum", vmType: "ethereum-vm", depository: addr("d1") },
    ]
    const stage = { deferredBuilderVmTypes: new Set(["ton-vm"]) }
    expect(await checkPayloadBuilders(ctx(stage, chains))).toBe(1)
    expect(lines.join("\n")).toMatch(/ton \(ton-vm\): not registered yet/)
    expect(lines.join("\n")).toMatch(/ethereum \(ethereum-vm\): NOT set/)
  })

  it("fails a chain with one unregistered depository even when another matches", async () => {
    const chains = [
      {
        id: "ethereum",
        vmType: "ethereum-vm",
        depository: addr("d1"),
        additionalDepositories: [addr("d2")],
      },
    ]
    registrations[`ethereum:${encoded("ethereum-vm", addr("d1"))}`] =
      deployment.ethereumVmPayloadBuilder
    expect(await checkPayloadBuilders(ctx({}, chains))).toBe(1)
    expect(lines.join("\n")).toContain(`${addr("d2")}=unset`)
    registrations[`ethereum:${encoded("ethereum-vm", addr("d2"))}`] =
      deployment.ethereumVmPayloadBuilder
    expect(await checkPayloadBuilders(ctx({}, chains))).toBe(0)
  })

  it("allows the oracle config to name the previous contract, and nothing else", async () => {
    const config = { allocatorAddress: previousAllocator }
    const only = (c: Ctx) =>
      ({ ...c, config, deployment: { allocator: deployment.allocator } }) as Ctx
    const stage = { previousAddresses: { allocator: previousAllocator } }
    expect(await checkAddressConsistency(only(ctx(stage)))).toBe(0)
    expect(lines.join("\n")).toMatch(/off-chain config moves at rollout/)
    expect(await checkAddressConsistency(only(ctx()))).toBe(1)
    const third = { allocatorAddress: addr("c9") }
    expect(
      await checkAddressConsistency({
        ...only(ctx(stage)),
        config: third,
      } as Ctx)
    ).toBe(1)
  })
})
