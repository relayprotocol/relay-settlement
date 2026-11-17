import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  keccak256,
  toHex,
  zeroAddress,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  parseAbi,
} from "viem"
import type { Address, Hex } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"

// The chain the redeploy phases read, and the state file they load
const chain = vi.hoisted(() => ({
  configAllocator: "" as string,
  owners: {} as Record<string, string>,
  configValues: {} as Record<string, string>,
  hasRole: false,
  // Overrides hasRole per account when set
  hasRoleFor: undefined as ((account: string) => boolean) | undefined,
  pendingOwners: {} as Record<string, string>,
  // payloadBuilders(chainId, encoded depository) on any allocator
  registrations: {} as Record<string, string>,
  state: undefined as unknown,
  logs: [] as string[],
}))

// verify-deployment.ts, as verify runs it
const verifier = vi.hoisted(() => ({
  fails: false,
  env: {} as Record<string, string | undefined>,
}))
vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  execFileSync: (
    _file: string,
    _args: string[],
    options: { env: Record<string, string | undefined> }
  ) => {
    verifier.env = options.env
    if (verifier.fails) throw new Error("Command failed: yarn ts-node")
    return ""
  },
}))

vi.mock("../../deployments/scripts/redeploy/common", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../deployments/scripts/redeploy/common")
    >()
  return {
    ...original,
    loadState: () => chain.state,
    log: (line: string) => chain.logs.push(line),
    publicClient: () => ({
      getChainId: async () => 1,
      getTransactionCount: async () => 0,
      estimateGas: async () => 21000n,
      readContract: async ({
        address,
        functionName,
        args,
      }: {
        address: string
        functionName: string
        args?: unknown[]
      }) => {
        if (functionName === "hasRole")
          return chain.hasRoleFor
            ? chain.hasRoleFor(args?.[1] as string)
            : chain.hasRole
        if (functionName === "payloadBuilders")
          return chain.registrations[`${args?.[0]}:${args?.[1]}`] ?? zeroAddress
        if (functionName === "pendingOwner")
          return chain.pendingOwners[address] ?? zeroAddress
        if (/^get\w+Key$/.test(functionName) && functionName !== "getGasFeeKey")
          return builderKey(functionName, args ?? [])
        if (functionName === "allocator") return chain.configAllocator
        if (functionName === "owner") return chain.owners[address]
        if (functionName === "getGasFeeKey") return tonGasFeeKey
        if (functionName === "getConfigValue") {
          const value = chain.configValues[args?.[0] as string]
          if (value === undefined) throw notSet(args?.[0] as Hex)
          return value
        }
        throw new Error(`unexpected read ${functionName}`)
      },
    }),
  }
})

import {
  CORE_CONTRACTS,
  fromDeploymentKeys,
  parseArgs,
  toDeploymentKey,
} from "../../deployments/scripts/redeploy/common"
import type { RedeployState } from "../../deployments/scripts/redeploy/common"
import {
  gatewayConfigWrites,
  parseGatewayAllocators,
  tonConfigWrites,
} from "../../deployments/scripts/redeploy/config-values"
import {
  configure,
  CUTOVER_VM_TYPES,
} from "../../deployments/scripts/redeploy/configure"
import {
  manifestActivate,
  manifestCutover,
  manifestRegister,
} from "../../deployments/scripts/redeploy/manifests"
import { hasCode } from "../../deployments/scripts/redeploy/common"
import {
  BUILDERS,
  CORE,
  forgeEnv,
  forgeScriptArgs,
  requiredBuilders,
} from "../../deployments/scripts/redeploy/deploy"
import {
  assertNoDroppedRegistrations,
  assertNoUnknownRegistrations,
  assertReinventorySafe,
  fromBlockFlag,
  RETIRED_REGISTRATIONS,
} from "../../deployments/scripts/redeploy/inventory"
import {
  checkRegistrations,
  verifierStage,
  verify,
} from "../../deployments/scripts/redeploy/records"
import { encodedDepository } from "../../deployments/scripts/redeploy/configure"

const state = (vmTypes: [string, string][]): RedeployState =>
  ({
    chains: vmTypes.map(([vmType, builderKey], i) => ({
      id: `chain-${i}`,
      vmType,
      depository: "0x",
      builderKey,
    })),
  }) as unknown as RedeployState

describe("redeploy", () => {
  it("parses --env and --phase, with or without =", () => {
    expect(
      parseArgs(["--env", "prod", "--phase=deploy", "--dry-run"])
    ).toMatchObject({
      env: "prod",
      phase: "deploy",
      dryRun: true,
    })
  })

  it("rejects an unknown env", () => {
    expect(() => parseArgs(["--env", "mainnet", "--phase", "deploy"])).toThrow(
      /--env/
    )
  })

  it("deploys only the builders the chain list needs", () => {
    expect(
      requiredBuilders(
        state([
          ["ethereum-vm", "ethereumVmPayloadBuilder"],
          ["ethereum-vm", "ethereumVmPayloadBuilder"],
          ["ton-vm", "tonVmPayloadBuilder"],
        ])
      )
    ).toEqual(["ethereumVmPayloadBuilder", "tonVmPayloadBuilder"])
  })

  it("adds the Gateway destination builder for gateway chains", () => {
    expect(
      requiredBuilders(state([["gateway-vm", "gatewayVmPayloadBuilder"]]))
    ).toEqual([
      "gatewayEthereumVmDestinationPayloadBuilder",
      "gatewayVmPayloadBuilder",
    ])
  })

  it("defers the Gateway and TON registrations to manifest-register", () => {
    expect([...CUTOVER_VM_TYPES].sort()).toEqual(["gateway-vm", "ton-vm"])
  })

  it("names the inbox contracts after RelayInbox, and keeps the deployment file keys", () => {
    expect(
      fromDeploymentKeys({
        oracle: "0x1",
        oracleMultisig: "0x2",
        oracleIdempotencyStore: "0x3",
        allocator: "0x4",
      })
    ).toEqual({
      inbox: "0x1",
      inboxMultisig: "0x2",
      inboxIdempotencyStore: "0x3",
      allocator: "0x4",
    })
    expect(toDeploymentKey("inbox")).toBe("oracle")
    expect(toDeploymentKey("inboxMultisig")).toBe("oracleMultisig")
    expect(toDeploymentKey("allocator")).toBe("allocator")
  })

  it("deploys no idempotency store, and runs the recipes in CORE_CONTRACTS order", () => {
    expect(Object.keys(CORE)).toEqual([...CORE_CONTRACTS])
    expect(CORE_CONTRACTS).not.toContain("inboxIdempotencyStore")
  })

  it("deploys the inbox on the live oracle's idempotency store", () => {
    const hub = "0xa884543c91156098B2e50aE17c3840770B7B55f5"
    const live = "0x481456de34aBfFe5E72CEEA597AAB19D852E6413"
    expect(
      CORE.inbox.env({
        deployed: {
          inboxIdempotencyStore: "0x35AC195391A9D41c9742E7a6796493a83294D9DD",
        },
        hub,
        inputs: { idempotencyStore: live },
      } as unknown as RedeployState)
    ).toEqual({ HUB: hub, IDEMPOTENCY_STORE: live })
  })

  it("refuses to deploy the inbox before inventory recorded the store", () => {
    expect(() =>
      CORE.inbox.env({
        deployed: {},
        hub: "0xa884543c91156098B2e50aE17c3840770B7B55f5",
        inputs: {},
      } as unknown as RedeployState)
    ).toThrow(/idempotency store/)
  })
})

const tonGasFeeKey = `0x${"77".repeat(32)}` as Hex
// A Gateway builder key getter's result, distinct per getter and arguments
const builderKey = (functionName: string, args: readonly unknown[]) =>
  keccak256(toHex(`${functionName}:${args.join(",")}`))

// The revert viem raises for Config.getConfigValue on an unset key
const notSetAbi = parseAbi(["error ConfigValueNotSet(bytes32 key)"])
const notSet = (key: Hex) =>
  new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({
      abi: notSetAbi,
      data: encodeErrorResult({
        abi: notSetAbi,
        args: [key],
        errorName: "ConfigValueNotSet",
      }),
      functionName: "getConfigValue",
    }),
    { abi: notSetAbi, args: [key], functionName: "getConfigValue" }
  )
const council = `0x${"c0".repeat(20)}` as Address
const previousAllocator = `0x${"a0".repeat(20)}` as Address
const newAllocator = `0x${"a1".repeat(20)}` as Address
const config = `0x${"cf".repeat(20)}` as Address
const deployerKey = generatePrivateKey()
const deployer = privateKeyToAccount(deployerKey).address

const tonGasFee5 = `0x${"00".repeat(31)}05` as Hex

// Mid-redeploy state: the new allocator is deployed and still the deployer's
const redeployState = (
  chains: {
    id: string
    vmType: string
    depository?: string
    gatewaySource?: string
    builderKey?: string
  }[] = []
) =>
  ({
    env: "dev",
    chainId: 1,
    hub: `0x${"40".repeat(20)}`,
    config,
    council,
    previous: {
      allocator: previousAllocator,
      executor: `0x${"a2".repeat(20)}`,
      inbox: `0x${"a3".repeat(20)}`,
      inboxMultisig: `0x${"a4".repeat(20)}`,
      genericMapping: `0x${"a5".repeat(20)}`,
    },
    inputs: {
      idempotencyStore: `0x${"50".repeat(20)}`,
      fundingPools: [],
    },
    chains: chains.map((c) => ({ depository: "1", builderKey: "x", ...c })),
    deployed: {
      allocator: newAllocator,
      inbox: `0x${"60".repeat(20)}`,
      inboxMultisig: `0x${"61".repeat(20)}`,
      executor: `0x${"62".repeat(20)}`,
      tonVmPayloadBuilder: `0x${"63".repeat(20)}`,
      lighterVmPayloadBuilder: `0x${"68".repeat(20)}`,
      gatewayVmPayloadBuilder: `0x${"64".repeat(20)}`,
      gatewayEthereumVmDestinationPayloadBuilder: `0x${"65".repeat(20)}`,
    },
    steps: {},
  }) as unknown as RedeployState

// After handover and round 1: the council owns the new allocator and the
// inbox multisig
// manifest-activate executed: the new allocator holds Hub OPERATOR_ROLE and
// Config points at it
const activated = () => {
  chain.hasRole = true
  chain.configAllocator = newAllocator
}

const councilOwnsNewContracts = () => {
  chain.owners[newAllocator] = council
  chain.owners[(chain.state as RedeployState).deployed.inboxMultisig] = council
}

describe("redeploy Config admin", () => {
  beforeEach(() => {
    process.env.DEPLOYER_PRIVATE_KEY = deployerKey
    chain.configAllocator = previousAllocator
    chain.owners = {
      [previousAllocator]: council,
      [newAllocator]: deployer,
      [redeployState().deployed.inboxMultisig]: deployer,
    }
    chain.configValues = {}
    chain.hasRole = false
    chain.hasRoleFor = undefined
    chain.pendingOwners = {}
    chain.registrations = {}
    verifier.fails = false
    chain.state = redeployState()
    chain.logs = []
  })
  afterEach(() => {
    delete process.env.DEPLOYER_PRIVATE_KEY
    delete process.env.TON_GAS_FEE
    delete process.env.INCLUDE_GATEWAY
    delete process.env.INCLUDE_TON
    delete process.env.INCLUDE_MAPPING_FREEZE
    delete process.env.CONFIRM_RETIREMENT
    delete process.env.ALLOW_PARTIAL_RETIREMENT
    delete process.env.MIGRATION_REVIEWED
    delete process.env.RELAY_RPC_URL
    delete process.env.GATEWAY_ALLOCATORS
    delete process.env.MAX_BLOCK_HEIGHT
  })

  it("registers TON in manifest-register, after its TON_VM_GAS_FEE", async () => {
    councilOwnsNewContracts()
    activated()
    chain.state = redeployState([
      { id: "ton", vmType: "ton-vm", depository: `0:${"f3".repeat(32)}` },
    ])
    process.env.INCLUDE_TON = "1"
    process.env.TON_GAS_FEE = "5"
    await manifestRegister("dev", true)
    expect(chain.logs.filter((line) => line.startsWith("  + "))).toEqual([
      "  + TON_VM_GAS_FEE ton",
      "  + register ton (TON)",
    ])
  })

  it("refuses manifest-register without INCLUDE_TON or INCLUDE_GATEWAY", async () => {
    councilOwnsNewContracts()
    await expect(manifestRegister("dev", true)).rejects.toThrow(
      /INCLUDE_TON=1, INCLUDE_GATEWAY=1 and\/or INCLUDE_MAPPING_FREEZE=1/
    )
  })

  it("refuses the TON registration before the council owns the new allocator", async () => {
    chain.state = redeployState([{ id: "ton", vmType: "ton-vm" }])
    process.env.INCLUDE_TON = "1"
    await expect(manifestRegister("dev", true)).rejects.toThrow(
      /New allocator owner .* not the council: run --phase handover first/
    )
  })

  it("keeps manifest-cutover to revocations, whatever the registration flags", async () => {
    councilOwnsNewContracts()
    process.env.CONFIRM_RETIREMENT = "1"
    // TON and Gateway are not registered: retire anyway, as allowed
    process.env.ALLOW_PARTIAL_RETIREMENT = "1"
    chain.state = redeployState([
      { id: "ton", vmType: "ton-vm", depository: `0:${"f3".repeat(32)}` },
      {
        id: "polygon-gateway",
        vmType: "gateway-vm",
        depository: `0x${"66".repeat(20)}`,
        gatewaySource: "polygon",
      },
    ])
    process.env.INCLUDE_TON = "1"
    process.env.INCLUDE_GATEWAY = "1"
    process.env.TON_GAS_FEE = "5"
    activated()
    await manifestCutover("dev", true)
    const added = chain.logs.filter((line) => line.startsWith("  + "))
    expect(added.length).toBeGreaterThan(0)
    for (const line of added) expect(line).toMatch(/✗/)
    expect(chain.logs.join("\n")).toMatch(/Retirement \(DEC-2469 step 6\)/)
  })

  it("hands over before cutover, while the previous contracts keep their roles", async () => {
    process.env.RELAY_RPC_URL = "http://127.0.0.1:8545"
    const { handover } = await import(
      "../../deployments/scripts/redeploy/handover"
    )
    await handover("dev", true)
    expect(chain.logs.join("\n")).toMatch(
      /would send allocator\.transferOwnership\(council\)/
    )
  })

  it("skips TON_VM_GAS_FEE once set, and needs TON_GAS_FEE only while it is unset", async () => {
    const state = redeployState([{ id: "ton", vmType: "ton-vm" }])
    await expect(tonConfigWrites(state)).rejects.toThrow(/TON_GAS_FEE/)
    chain.configValues[tonGasFeeKey] = tonGasFee5
    await expect(tonConfigWrites(state)).resolves.toEqual([])
    process.env.TON_GAS_FEE = "6"
    await expect(tonConfigWrites(state)).resolves.toMatchObject([
      { keys: [tonGasFeeKey], values: [`0x${"00".repeat(31)}06`] },
    ])
  })

  it("dedupes the Gateway allocators", () => {
    const a = `0x${"ab".repeat(20)}`
    expect(
      parseGatewayAllocators(`${a}, ${a.toUpperCase().replace("0X", "0x")}`)
    ).toHaveLength(1)
    expect(() => parseGatewayAllocators("0x12")).toThrow(/not an address/)
  })

  describe("Gateway", () => {
    const gatewayChain = {
      id: "polygon-gateway",
      vmType: "gateway-vm",
      depository: `0x${"66".repeat(20)}`,
      gatewaySource: "polygon",
    }
    beforeEach(() => {
      process.env.GATEWAY_ALLOCATORS = `0x${"67".repeat(20)}`
      process.env.MAX_BLOCK_HEIGHT = "1000"
      chain.state = redeployState([gatewayChain])
    })

    it("leaves out the Gateway Config entries already on-chain, and keeps shared ones that differ", async () => {
      const state = chain.state as RedeployState
      const [all] = await gatewayConfigWrites(state)
      // The first chain's Circle domain matches; its token differs and is a
      // shared key the redeploy does not change on purpose
      chain.configValues[all.keys[0]] = all.values[0]
      chain.configValues[all.keys[1]] = `0x${"00".repeat(32)}`
      const [remaining] = await gatewayConfigWrites(state)
      expect(remaining.keys).toEqual(all.keys.slice(2))
      for (let i = 0; i < all.keys.length; i++)
        chain.configValues[all.keys[i]] = all.values[i]
      await expect(gatewayConfigWrites(state)).resolves.toEqual([])
    })

    it("puts the Gateway registration before its shared Config in one manifest-register with INCLUDE_GATEWAY", async () => {
      councilOwnsNewContracts()
      activated()
      process.env.INCLUDE_GATEWAY = "1"
      await manifestRegister("dev", true)
      const added = chain.logs.filter((line) => line.startsWith("  + "))
      expect(added).toEqual([
        "  + register polygon-gateway (Gateway)",
        expect.stringMatching(/^ {2}\+ Gateway Config polygon-gateway/),
      ])
    })

    it("leaves the Gateway out of manifest-register without INCLUDE_GATEWAY", async () => {
      councilOwnsNewContracts()
      activated()
      process.env.INCLUDE_TON = "1"
      await manifestRegister("dev", true)
      expect(chain.logs.join("\n")).not.toMatch(/Gateway/)
    })

    it("refuses the Gateway registration before the council owns the new allocator", async () => {
      process.env.INCLUDE_GATEWAY = "1"
      await expect(manifestRegister("dev", true)).rejects.toThrow(
        /New allocator owner .* not the council: run --phase handover first/
      )
    })

    it("refuses the Gateway registration while the council is not the Config admin", async () => {
      councilOwnsNewContracts()
      chain.owners[previousAllocator] = deployer
      process.env.INCLUDE_GATEWAY = "1"
      await expect(manifestRegister("dev", true)).rejects.toThrow(
        /The Config admin .* not the council: run --phase handover first/
      )
    })
  })

  describe("manifest-activate", () => {
    const multisig = () => (chain.state as RedeployState).deployed.inboxMultisig
    const added = () => chain.logs.filter((line) => line.startsWith("  + "))
    // handover done: the council owns the allocator and is the multisig's
    // pending owner
    const handedOver = () => {
      chain.owners[newAllocator] = council
      chain.pendingOwners[multisig()] = council
    }
    const lighter = {
      id: "lighter",
      vmType: "lighter-vm",
      depository: "730948",
      builderKey: "lighterVmPayloadBuilder",
    }

    it("is one manifest: grants, Lighter Config, multisig acceptance, then setAllocator last", async () => {
      handedOver()
      chain.state = redeployState([lighter])
      process.env.MIGRATION_REVIEWED = "1"
      await manifestActivate("dev", true)
      expect(added()).toEqual([
        "  + Hub OPERATOR_ROLE → allocator",
        "  + Hub OPERATOR_ROLE → executor",
        "  + Hub OPERATOR_ROLE → inbox",
        "  + idempotency store WRITE_ROLE → inbox",
        "  + Lighter Config lighter",
        "  + RelayInboxMultisig.acceptOwnership()",
        "  + Config.setAllocator(new allocator)",
      ])
    })

    it("is refused before handover", async () => {
      await expect(manifestActivate("dev", true)).rejects.toThrow(
        /New allocator owner .* not the council: run --phase handover first/
      )
      chain.owners[newAllocator] = council
      await expect(manifestActivate("dev", true)).rejects.toThrow(
        /pending owner of the inbox multisig: run --phase handover first/
      )
    })

    it("holds only acceptOwnership on dev's state after handover", async () => {
      // Grants from the legacy manifest-wire, Config already re-pointed
      handedOver()
      chain.configAllocator = newAllocator
      chain.hasRole = true
      await manifestActivate("dev", true)
      expect(added()).toEqual(["  + RelayInboxMultisig.acceptOwnership()"])
    })

    it("registers Lighter in configure, and leaves TON and Gateway for round 2", async () => {
      process.env.RELAY_RPC_URL = "http://127.0.0.1:8545"
      chain.state = redeployState([
        lighter,
        { id: "ton", vmType: "ton-vm" },
        { id: "polygon-gateway", vmType: "gateway-vm" },
      ])
      await configure("dev", true)
      const sent = chain.logs.filter((line) => line.includes("would send"))
      expect(sent.some((line) => line.includes("register lighter"))).toBe(true)
      expect(
        sent.some((line) => /register (ton|polygon-gateway)/.test(line))
      ).toBe(false)
    })

    it("freezes the previous mapping in manifest-register with INCLUDE_MAPPING_FREEZE", async () => {
      handedOver()
      activated()
      process.env.INCLUDE_MAPPING_FREEZE = "1"
      await manifestRegister("dev", true)
      expect(added()).toEqual([
        "  + previous GenericMapping ORACLE_ROLE ✗ previous multisig",
      ])
    })

    it("skips the mapping freeze in manifest-cutover once round 2 did it", async () => {
      process.env.CONFIRM_RETIREMENT = "1"
      handedOver()
      chain.configAllocator = newAllocator
      // Only the new allocator holds Hub OPERATOR_ROLE: the previous contracts'
      // roles are already gone
      chain.hasRoleFor = (account) => account === newAllocator
      await manifestCutover("dev", true)
      expect(chain.logs).toContain(
        "  ✓ previous GenericMapping ORACLE_ROLE ✗ previous multisig (already in place)"
      )
    })
  })

  describe("review fixes", () => {
    const ethereumBuilder = `0x${"e1".repeat(20)}` as Address
    const primary = `0x${"d1".repeat(20)}`
    const extra = `0x${"d2".repeat(20)}`
    const ethereum = {
      id: "ethereum",
      vmType: "ethereum-vm",
      depository: primary,
      depositories: [primary, extra],
      builderKey: "ethereumVmPayloadBuilder",
    }
    const multiState = () => {
      const s = redeployState([ethereum])
      s.deployed.ethereumVmPayloadBuilder = ethereumBuilder
      s.previousRegistrations = [primary, extra].map((depository) => ({
        chainId: "ethereum",
        depository,
        builder: `0x${"b0".repeat(20)}` as Address,
      }))
      return s
    }
    const register = (depository: string) => {
      chain.registrations[
        `ethereum:${encodedDepository("ethereum-vm", depository)}`
      ] = ethereumBuilder
    }

    it("registers the builder under every depository of a chain", async () => {
      process.env.RELAY_RPC_URL = "http://127.0.0.1:8545"
      chain.state = multiState()
      await configure("dev", true)
      const sent = chain.logs.filter((line) => line.includes("would send"))
      expect(sent.filter((line) => line.includes("setPayloadBuilder"))).toEqual(
        [
          expect.stringMatching(/^ {2}would send register ethereum: /),
          expect.stringMatching(
            new RegExp(`^ {2}would send register ethereum ${extra}: `)
          ),
        ]
      )
    })

    it("verifies every depository, and detects a missing one", async () => {
      const state = multiState()
      register(primary)
      expect((await checkRegistrations(state)).failures).toBe(1)
      expect(chain.logs.join("\n")).toMatch(
        new RegExp(`❌ ethereum .*${extra}`)
      )
      register(extra)
      expect((await checkRegistrations(state)).failures).toBe(0)
    })

    it("detects a previous registration the redeploy does not reproduce", async () => {
      const state = multiState()
      register(primary)
      register(extra)
      state.previousRegistrations?.push({
        chainId: "base",
        depository: primary,
        builder: ethereumBuilder,
      })
      expect((await checkRegistrations(state)).failures).toBe(1)
    })

    it("fails verify when verify-deployment.ts fails", async () => {
      process.env.RELAY_RPC_URL = "http://127.0.0.1:8545"
      chain.state = multiState()
      register(primary)
      register(extra)
      await expect(verify("dev")).resolves.toBeUndefined()
      verifier.fails = true
      await expect(verify("dev")).rejects.toThrow(
        /verify-deployment.ts failed or could not run/
      )
    })

    it("keeps an existing differing Gateway value, but sets the destination builder", async () => {
      process.env.GATEWAY_ALLOCATORS = `0x${"67".repeat(20)}`
      const state = redeployState([
        {
          id: "polygon-gateway",
          vmType: "gateway-vm",
          depository: `0x${"66".repeat(20)}`,
          gatewaySource: "polygon",
        },
      ])
      const gasFeeKey = tonGasFeeKey
      const destinationKey = builderKey("getDestinationBuilderKey", ["polygon"])
      const tuned = `0x${"00".repeat(31)}09`
      chain.configValues[gasFeeKey] = tuned
      chain.configValues[destinationKey] =
        `0x${"00".repeat(12)}${"99".repeat(20)}`
      const keys = (await gatewayConfigWrites(state)).flatMap((w) => w.keys)
      expect(keys).not.toContain(gasFeeKey)
      expect(keys).toContain(destinationKey)
      expect(chain.logs.join("\n")).toMatch(
        /\[keep\] polygon-gateway\.gasFee is 0x0+9 on-chain/
      )
    })

    it("never puts the deployer key in forge's argv", () => {
      process.env.DEPLOYER_PRIVATE_KEY = deployerKey
      for (const recipe of [
        ...Object.values(CORE),
        ...Object.values(BUILDERS),
      ]) {
        expect(recipe.script).toMatch(/\.s\.sol$/)
        const args = forgeScriptArgs(recipe, "http://127.0.0.1:8545")
        expect(args.join(" ")).not.toContain(deployerKey.slice(2))
        expect(args).not.toContain("--private-key")
      }
    })

    it("refuses --force once <env>.json holds the deployed contracts", () => {
      const existing = redeployState()
      expect(() =>
        assertReinventorySafe(existing, {
          allocator: existing.deployed.allocator,
        })
      ).toThrow(/Refusing --force/)
      expect(() =>
        assertReinventorySafe(existing, {
          allocator: `0x${"a9".repeat(20)}` as Address,
        })
      ).toThrow(/allocator changed from/)
      expect(() =>
        assertReinventorySafe(existing, { ...existing.previous })
      ).not.toThrow()
    })
  })

  describe("verify stages", () => {
    const tonBuilder = `0x${"63".repeat(20)}` as Address
    const ton = (depositories: string[]) => ({
      id: "ton",
      vmType: "ton-vm",
      depository: depositories[0],
      depositories,
      builderKey: "tonVmPayloadBuilder",
    })
    const tonA = `0:${"f3".repeat(32)}`
    const tonB = `0:${"f4".repeat(32)}`
    const registerTon = (depository: string) => {
      chain.registrations[`ton:${encodedDepository("ton-vm", depository)}`] =
        tonBuilder
    }

    it("passes verify before manifest-activate with only the stage allowances", async () => {
      process.env.RELAY_RPC_URL = "http://127.0.0.1:8545"
      chain.state = redeployState([ton([tonA])])
      // The new allocator has no Hub OPERATOR_ROLE yet, TON is not registered
      await expect(verify("dev")).resolves.toBeUndefined()
      expect(verifier.env).toMatchObject({
        PENDING_HUB_GRANTS: "1",
        DEFERRED_BUILDER_VM_TYPES: "ton-vm",
        PREVIOUS_ORACLES: `0x${"a3".repeat(20)}`,
      })
      expect(verifier.env.PREVIOUS_CONTRACTS?.split(",")).toEqual(
        expect.arrayContaining([
          `hub:OPERATOR_ROLE:${previousAllocator}`,
          `hub:OPERATOR_ROLE:0x${"a2".repeat(20)}`,
        ])
      )
    })

    it("fails verify on an issue the stage does not allow", async () => {
      process.env.RELAY_RPC_URL = "http://127.0.0.1:8545"
      chain.state = redeployState([ton([tonA])])
      verifier.fails = true
      await expect(verify("dev")).rejects.toThrow(/verify-deployment.ts failed/)
    })

    it("drops the allowances once manifest-activate and manifest-register executed", async () => {
      const state = redeployState([ton([tonA])])
      registerTon(tonA)
      chain.hasRole = true
      const { deferred } = await checkRegistrations(state)
      const stage = await verifierStage(state, deferred)
      expect(stage.PENDING_HUB_GRANTS).toBeUndefined()
      expect(stage.DEFERRED_BUILDER_VM_TYPES).toBeUndefined()
    })

    it("fails an unregistered TON depository once round 2 registered another", async () => {
      const state = redeployState([ton([tonA, tonB])])
      expect(await checkRegistrations(state)).toMatchObject({ failures: 0 })
      registerTon(tonA)
      const result = await checkRegistrations(state)
      expect(result.failures).toBe(1)
      expect(result.deferred.has("ton-vm")).toBe(false)
    })

    it("refuses an inventory that skips a chain registered on the previous allocator", async () => {
      const client = {
        readContract: async ({ args }: { args: unknown[] }) =>
          args[0] === "skipped" ? `0x${"b9".repeat(20)}` : zeroAddress,
      }
      const dropped = [
        {
          chainId: "kept",
          vmType: "ethereum-vm",
          depository: `0x${"d1".repeat(20)}`,
        },
        {
          chainId: "skipped",
          vmType: "ethereum-vm",
          depository: `0x${"d2".repeat(20)}`,
        },
      ]
      await expect(
        assertNoDroppedRegistrations(
          client as never,
          previousAllocator,
          dropped
        )
      ).rejects.toThrow(
        /skips depositories that are registered on the previous allocator: skipped/
      )
      await expect(
        assertNoDroppedRegistrations(
          client as never,
          previousAllocator,
          dropped.slice(0, 1)
        )
      ).resolves.toBeUndefined()
    })
  })

  describe("review round 3", () => {
    const ethereumBuilder = `0x${"e1".repeat(20)}` as Address
    const primary = `0x${"d1".repeat(20)}`
    const extra = `0x${"d2".repeat(20)}`
    const ethereum = {
      id: "ethereum",
      vmType: "ethereum-vm",
      depository: primary,
      depositories: [primary, extra],
      builderKey: "ethereumVmPayloadBuilder",
    }
    // The previous allocator registered only the primary depository
    const onlyPrimary = () => {
      const s = redeployState([ethereum])
      s.deployed.ethereumVmPayloadBuilder = ethereumBuilder
      s.previousRegistrations = [
        { chainId: "ethereum", depository: primary, builder: ethereumBuilder },
      ]
      return s
    }
    const register = (depository: string) => {
      chain.registrations[
        `ethereum:${encodedDepository("ethereum-vm", depository)}`
      ] = ethereumBuilder
    }

    it("registers every configured depository, like the verifier expects, even one the previous allocator lacked", async () => {
      process.env.RELAY_RPC_URL = "http://127.0.0.1:8545"
      chain.state = onlyPrimary()
      await configure("dev", true)
      const sent = chain.logs.filter((line) =>
        line.includes("setPayloadBuilder")
      )
      expect(sent).toHaveLength(2)
      register(primary)
      expect((await checkRegistrations(onlyPrimary())).failures).toBe(1)
      register(extra)
      expect((await checkRegistrations(onlyPrimary())).failures).toBe(0)
    })

    it("refuses a skipped depository it cannot probe", async () => {
      const client = { readContract: async () => zeroAddress }
      await expect(
        assertNoDroppedRegistrations(client as never, previousAllocator, [
          { chainId: "odd", vmType: "unknown-vm", depository: "x" },
        ])
      ).rejects.toThrow(/Cannot probe skipped depository odd/)
    })

    it("refuses a previous registration for a chain absent from the config", async () => {
      const event = (chainId: string, depository: string, builder: string) => ({
        args: {
          chainId: keccak256(toHex(chainId)),
          depository: keccak256(encodedDepository("ethereum-vm", depository)),
          builder,
        },
      })
      const pages: unknown[][] = []
      const client = {
        getBlockNumber: async () => 25n,
        getLogs: async ({
          fromBlock,
          toBlock,
        }: {
          fromBlock: bigint
          toBlock: bigint
        }) => {
          pages.push([fromBlock, toBlock])
          return fromBlock === 0n
            ? [
                event("ethereum", primary, ethereumBuilder),
                event("removed", primary, ethereumBuilder),
              ]
            : [
                event("deregistered", primary, ethereumBuilder),
                event("deregistered", primary, zeroAddress),
              ]
        },
      }
      const known = [
        { chainId: "ethereum", vmType: "ethereum-vm", depository: primary },
      ]
      await expect(
        assertNoUnknownRegistrations(
          client as never,
          previousAllocator,
          known,
          0n,
          10n
        )
      ).rejects.toThrow(/absent from the chains config/)
      expect(pages).toEqual([
        [0n, 9n],
        [10n, 19n],
        [20n, 25n],
      ])
      const known2 = [
        ...known,
        { chainId: "removed", vmType: "ethereum-vm", depository: primary },
      ]
      await expect(
        assertNoUnknownRegistrations(
          client as never,
          previousAllocator,
          known2,
          0n,
          10n
        )
      ).resolves.toBeUndefined()
    })

    it("ignores stage allowances inherited from the operator's shell", async () => {
      process.env.RELAY_RPC_URL = "http://127.0.0.1:8545"
      process.env.PENDING_HUB_GRANTS = "1"
      process.env.DEFERRED_BUILDER_VM_TYPES = "ethereum-vm"
      try {
        chain.state = onlyPrimary()
        register(primary)
        register(extra)
        activated()
        await verify("dev")
        expect(verifier.env.PENDING_HUB_GRANTS).toBeUndefined()
        expect(verifier.env.DEFERRED_BUILDER_VM_TYPES).toBeUndefined()
      } finally {
        delete process.env.PENDING_HUB_GRANTS
        delete process.env.DEFERRED_BUILDER_VM_TYPES
      }
    })

    it("refuses manifest-register until manifest-activate executed", async () => {
      councilOwnsNewContracts()
      process.env.INCLUDE_MAPPING_FREEZE = "1"
      await expect(manifestRegister("dev", true)).rejects.toThrow(
        /manifest-activate has not executed/
      )
      activated()
      await expect(manifestRegister("dev", true)).resolves.toBeUndefined()
    })
  })

  describe("review round 4", () => {
    const tonA = `0:${"f3".repeat(32)}`
    const tonState = () => {
      const state = redeployState([
        {
          id: "ton",
          vmType: "ton-vm",
          depository: tonA,
          builderKey: "tonVmPayloadBuilder",
        },
      ])
      state.previousRegistrations = [
        {
          chainId: "ton",
          depository: tonA,
          builder: `0x${"b2".repeat(20)}` as Address,
        },
      ]
      return state
    }

    it("refuses manifest-cutover without CONFIRM_RETIREMENT, naming the step 6 conditions", async () => {
      await expect(manifestCutover("dev", true)).rejects.toThrow(
        /CONFIRM_RETIREMENT=1 once DEC-2469 step 6 holds: DEC-2471 has shipped/
      )
    })

    it("refuses manifest-cutover before manifest-activate", async () => {
      process.env.CONFIRM_RETIREMENT = "1"
      await expect(manifestCutover("dev", true)).rejects.toThrow(
        /manifest-activate has not executed/
      )
    })

    it("refuses manifest-cutover until TON is registered, unless partial retirement is allowed", async () => {
      process.env.CONFIRM_RETIREMENT = "1"
      chain.state = tonState()
      activated()
      await expect(manifestCutover("dev", true)).rejects.toThrow(
        /Not registered on the new allocator yet: ton /
      )
      process.env.ALLOW_PARTIAL_RETIREMENT = "1"
      await manifestCutover("dev", true)
      expect(chain.logs.join("\n")).toMatch(
        /ALLOW_PARTIAL_RETIREMENT=1: retiring while ton/
      )
      delete process.env.ALLOW_PARTIAL_RETIREMENT
      chain.registrations[`ton:${encodedDepository("ton-vm", tonA)}`] =
        `0x${"63".repeat(20)}`
      await expect(manifestCutover("dev", true)).resolves.toBeUndefined()
    })

    describe("a Gateway source the previous allocator no longer serves", () => {
      // As prod after manifest 086: arc-gateway is the live source and
      // polygon-gateway, on the same depository, was unregistered
      const depository = `0x${"66".repeat(20)}`
      const gatewayBuilder = `0x${"64".repeat(20)}`
      const retiredSourceState = () => {
        const state = redeployState(
          ["polygon", "arc"].map((source) => ({
            id: `${source}-gateway`,
            vmType: "gateway-vm",
            depository,
            gatewaySource: source,
            builderKey: "gatewayVmPayloadBuilder",
          }))
        )
        state.previousRegistrations = [
          {
            chainId: "arc-gateway",
            depository,
            builder: `0x${"78".repeat(20)}` as Address,
          },
        ]
        return state
      }
      const registerArc = () => {
        chain.registrations[
          `arc-gateway:${encodedDepository("gateway-vm", depository)}`
        ] = gatewayBuilder
      }
      beforeEach(() => {
        process.env.GATEWAY_ALLOCATORS = `0x${"67".repeat(20)}`
        process.env.MAX_BLOCK_HEIGHT = "1000"
        chain.state = retiredSourceState()
      })

      it("registers and configures only the served source in manifest-register", async () => {
        councilOwnsNewContracts()
        activated()
        process.env.INCLUDE_GATEWAY = "1"
        await manifestRegister("dev", true)
        const added = chain.logs.filter((line) => line.startsWith("  + "))
        expect(added).toEqual([
          "  + register arc-gateway (Gateway)",
          expect.stringMatching(/^ {2}\+ Gateway Config arc-gateway/),
        ])
        expect(chain.logs).toContain(
          "  - polygon-gateway: not registered on the previous allocator, left out"
        )
      })

      it("reports it as left out in verify, and keeps the served source deferred", async () => {
        const state = retiredSourceState()
        const { failures, deferred } = await checkRegistrations(state)
        expect(failures).toBe(0)
        expect(deferred.has("gateway-vm")).toBe(true)
        expect(chain.logs.join("\n")).toMatch(
          /⏭️ {2}polygon-gateway .*not registered on the previous allocator: left out/
        )
        registerArc()
        expect((await checkRegistrations(state)).deferred.size).toBe(0)
      })

      it("does not require it before manifest-cutover", async () => {
        process.env.CONFIRM_RETIREMENT = "1"
        activated()
        await expect(manifestCutover("dev", true)).rejects.toThrow(
          /Not registered on the new allocator yet: arc-gateway /
        )
        registerArc()
        await expect(manifestCutover("dev", true)).resolves.toBeUndefined()
      })
    })

    it("treats undefined, 0x and 0x0 as no code", () => {
      expect([undefined, "0x", "0x0", "0x00"].map(hasCode)).toEqual([
        false,
        false,
        false,
        false,
      ])
      expect(hasCode("0x6080")).toBe(true)
    })

    it("requires --from-block for the event scan", () => {
      expect(() => fromBlockFlag(new Map())).toThrow(/Pass --from-block/)
      expect(fromBlockFlag(new Map([["from-block", "123"]]))).toBe(123n)
    })

    it("halves a range the RPC rejects and retries a transient error", async () => {
      const calls: string[] = []
      let transient = 1
      const client = {
        getBlockNumber: async () => 7n,
        getLogs: async ({
          fromBlock,
          toBlock,
        }: {
          fromBlock: bigint
          toBlock: bigint
        }) => {
          calls.push(`${fromBlock}-${toBlock}`)
          if (toBlock - fromBlock > 1n)
            throw new Error("query returned more than 10000 results")
          if (fromBlock === 4n && transient-- > 0)
            throw new Error("socket hang up")
          return []
        },
      }
      await assertNoUnknownRegistrations(
        client as never,
        previousAllocator,
        [],
        0n,
        8n
      )
      expect(calls).toEqual([
        "0-7",
        "0-3",
        "0-1",
        "2-3",
        "4-7",
        "4-5",
        "4-5",
        "6-7",
      ])
    })

    it("expects an abandoned inbox's roles only until manifest-activate", async () => {
      const abandoned = `0x${"a9".repeat(20)}`
      const state = {
        ...redeployState(),
        abandonedInboxes: [abandoned],
      } as RedeployState
      chain.hasRoleFor = () => false
      const pending = await verifierStage(state, new Set())
      expect(pending.PENDING_HUB_GRANTS).toBe("1")
      expect(pending.PREVIOUS_CONTRACTS?.split(",")).toEqual(
        expect.arrayContaining([
          `hub:OPERATOR_ROLE:${abandoned}`,
          `oracleIdempotencyStore:WRITE_ROLE:${abandoned}`,
        ])
      )
      chain.hasRoleFor = (account) => account === newAllocator
      const done = await verifierStage(state, new Set())
      expect(done.PREVIOUS_CONTRACTS ?? "").not.toContain(abandoned)
    })

    it("allows the previous set in the oracle config only until cutover", async () => {
      const state = redeployState()
      chain.hasRole = true
      const stage = await verifierStage(state, new Set())
      expect(stage.PENDING_CONFIG_ROLLOUT?.split(",")).toEqual(
        expect.arrayContaining([`allocator=${previousAllocator}`])
      )
      chain.hasRoleFor = (account) => account === newAllocator
      expect(
        (await verifierStage(state, new Set())).PENDING_CONFIG_ROLLOUT
      ).toBeUndefined()
    })
  })

  describe("review round 5", () => {
    const depository = `0x${"d1".repeat(20)}`
    const builder = `0x${"e1".repeat(20)}`
    const live = [
      { chainId: "ethereum", vmType: "ethereum-vm", depository, builder },
    ]

    it("fails when the event scan misses a live registration", async () => {
      const client = {
        getBlockNumber: async () => 5n,
        getLogs: async () => [],
      }
      await expect(
        assertNoUnknownRegistrations(
          client as never,
          previousAllocator,
          live as never,
          3n,
          10n
        )
      ).rejects.toThrow(
        /scan from block 3 misses live registrations of the previous allocator \(ethereum /
      )
      const found = {
        getBlockNumber: async () => 5n,
        getLogs: async () => [
          {
            args: {
              chainId: keccak256(toHex("ethereum")),
              depository: keccak256(
                encodedDepository("ethereum-vm", depository)
              ),
              builder,
            },
          },
        ],
      }
      await expect(
        assertNoUnknownRegistrations(
          found as never,
          previousAllocator,
          live as never,
          0n,
          10n
        )
      ).resolves.toBeUndefined()
    })

    it("retries a rate limit instead of halving the range", async () => {
      const calls: string[] = []
      let limited = 1
      const client = {
        getBlockNumber: async () => 3n,
        getLogs: async ({
          fromBlock,
          toBlock,
        }: {
          fromBlock: bigint
          toBlock: bigint
        }) => {
          calls.push(`${fromBlock}-${toBlock}`)
          if (limited-- > 0)
            throw new Error("429 Too Many Requests: rate limit exceeded")
          return []
        },
      }
      await assertNoUnknownRegistrations(
        client as never,
        previousAllocator,
        [],
        0n,
        4n
      )
      expect(calls).toEqual(["0-3", "0-3"])
    })
  })

  describe("retired registrations", () => {
    const depository = `0x${"d2".repeat(20)}`
    const builder = `0x${"e2".repeat(20)}` as `0x${string}`
    const retired = [
      {
        chainId: "deadchain",
        depositoryHash: keccak256(encodedDepository("ethereum-vm", depository)),
        builder,
        note: "test depository",
      },
    ]
    const scan = (liveBuilder: string) => ({
      getBlockNumber: async () => 5n,
      getLogs: async () => [
        {
          args: {
            chainId: keccak256(toHex("deadchain")),
            depository: retired[0].depositoryHash,
            builder: liveBuilder,
          },
        },
      ],
    })

    it("fails on an undeclared registration", async () => {
      await expect(
        assertNoUnknownRegistrations(
          scan(builder) as never,
          previousAllocator,
          [],
          0n,
          10n
        )
      ).rejects.toThrow(/absent from the chains config/)
    })

    it("leaves a declared one on the previous allocator", async () => {
      await expect(
        assertNoUnknownRegistrations(
          scan(builder) as never,
          previousAllocator,
          [],
          0n,
          10n,
          [],
          retired
        )
      ).resolves.toBeUndefined()
    })

    it("fails when a declared one was re-registered elsewhere", async () => {
      await expect(
        assertNoUnknownRegistrations(
          scan(`0x${"e3".repeat(20)}`) as never,
          previousAllocator,
          [],
          0n,
          10n,
          [],
          retired
        )
      ).rejects.toThrow(/now points at/)
    })

    it("declares the 22 stag pairs, the Tron one by its address", () => {
      const stag = RETIRED_REGISTRATIONS.stag ?? []
      expect(stag).toHaveLength(22)
      expect(new Set(stag.map((r) => r.chainId)).size).toBe(22)
      expect(stag.find((r) => r.chainId === "tron")?.depositoryHash).toBe(
        "0x19a7d7bbbbce11b75e27d8349d6b68b1591461307b0c998ef563939c51e72cdc"
      )
      expect(stag.find((r) => r.chainId === "lisk")?.depositoryHash).toBe(
        "0x7a0cd6f121126702647f54c316cd9914972a93e20271216ba76d95dafb5b6906"
      )
    })
  })

  it("never passes a stray OWNER or ADMIN from the shell to forge", () => {
    process.env.OWNER = `0x${"66".repeat(20)}`
    process.env.ADMIN = `0x${"67".repeat(20)}`
    process.env.CONFIG = `0x${"68".repeat(20)}`
    try {
      const state = redeployState()
      for (const recipe of [CORE.allocator, CORE.inbox, CORE.executor]) {
        const env = forgeEnv(state, recipe)
        expect(env.OWNER).toBe(deployer)
        expect(env.ADMIN).toBe(deployer)
        expect(env.CONFIG).toBeUndefined()
      }
      expect(forgeEnv(state, BUILDERS.ethereumVmPayloadBuilder).CONFIG).toBe(
        state.config
      )
    } finally {
      delete process.env.OWNER
      delete process.env.ADMIN
      delete process.env.CONFIG
    }
  })
})
