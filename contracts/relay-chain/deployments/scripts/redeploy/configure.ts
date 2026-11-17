import { bytesToHex, type Abi, type Address } from "viem"
import { encodeAddress } from "@relay-protocol/settlement-sdk"

import {
  accessControlAbi,
  allocatorAbi,
  deployerAccount,
  depositoriesOf,
  inboxAbi,
  loadState,
  log,
  ORACLE_ROLE,
  publicClient,
  requireChainId,
  sameAddress,
  saveState,
  walletClient,
  type ChainTarget,
  type Env,
  type RedeployState,
} from "./common"

// Chains whose new registration waits for the council's manifest-register,
// after round 1: the Gateway's GATEWAY_VM_DESTINATION_BUILDER Config key is
// shared with the live Gateway builder, and the TON Highload wallet must not
// be shared by two issuing allocators.
export const CUTOVER_VM_TYPES = new Set(["gateway-vm", "ton-vm"])

export const encodedDepository = (vmType: string, depository: string) =>
  bytesToHex(
    encodeAddress(
      depository,
      (vmType === "gateway-vm" ? "ethereum-vm" : vmType) as never
    )
  )

type Step = {
  id: string
  to: Address
  abi: Abi
  functionName: string
  args: readonly unknown[]
  done: () => Promise<boolean>
}

export async function runSteps(
  state: RedeployState,
  steps: Step[],
  dryRun: boolean
) {
  const client = publicClient(state.chainId)
  const wallet = walletClient(state.chainId)
  for (const step of steps) {
    if (await step.done()) {
      log(`  ✓ ${step.id}`)
      continue
    }
    if (dryRun) {
      log(
        `  would send ${step.id}: ${step.functionName}(${step.args.join(", ")}) on ${step.to}`
      )
      continue
    }
    const hash = await wallet.writeContract({
      address: step.to,
      abi: step.abi,
      functionName: step.functionName,
      args: step.args,
      chain: null,
    } as never)
    const receipt = await client.waitForTransactionReceipt({ hash })
    if (receipt.status !== "success")
      throw new Error(`${step.id} reverted: ${hash}`)
    state.steps[step.id] = hash
    saveState(state)
    log(`  → ${step.id} ${hash}`)
  }
}

export function roleStep(
  state: RedeployState,
  id: string,
  contract: Address,
  roleId: `0x${string}`,
  account: Address,
  action: "grantRole" | "revokeRole" | "renounceRole" = "grantRole"
): Step {
  const client = publicClient(state.chainId)
  return {
    id,
    to: contract,
    abi: accessControlAbi,
    functionName: action,
    args: [roleId, account],
    done: async () => {
      const has = await client.readContract({
        abi: accessControlAbi,
        address: contract,
        functionName: "hasRole",
        args: [roleId, account],
      })
      return action === "grantRole" ? has : !has
    },
  }
}

export async function configure(env: Env, dryRun: boolean) {
  const state = loadState(env)
  const client = publicClient(state.chainId)
  await requireChainId(client, state.chainId)
  const d = state.deployed
  const read = (
    address: Address,
    abi: Abi,
    functionName: string,
    args: unknown[] = []
  ) => client.readContract({ address, abi, functionName, args } as never)

  // No store steps: the inbox shares the live oracle's store, and its
  // WRITE_ROLE there comes from the council in --phase manifest-activate.
  const steps: Step[] = [
    roleStep(
      state,
      "inbox ORACLE_ROLE → multisig",
      d.inbox,
      ORACLE_ROLE,
      d.inboxMultisig
    ),
    roleStep(
      state,
      "executor ORACLE_ROLE → multisig",
      d.executor,
      ORACLE_ROLE,
      d.inboxMultisig
    ),
    roleStep(
      state,
      "genericMapping ORACLE_ROLE → multisig",
      d.genericMapping,
      ORACLE_ROLE,
      d.inboxMultisig
    ),
  ]
  if (state.inputs.rateLimiter) {
    steps.push({
      id: "inbox.addRateLimiter",
      to: d.inbox,
      abi: inboxAbi,
      functionName: "addRateLimiter",
      args: [state.inputs.rateLimiter],
      done: async () =>
        (await read(d.inbox, inboxAbi, "isRateLimiter", [
          state.inputs.rateLimiter,
        ])) as boolean,
    })
  }
  if (state.inputs.feeCalculator) {
    steps.push({
      id: "inbox.addFeeCalculator",
      to: d.inbox,
      abi: inboxAbi,
      functionName: "addFeeCalculator",
      args: [state.inputs.feeCalculator],
      done: async () =>
        (await read(d.inbox, inboxAbi, "isFeeCalculator", [
          state.inputs.feeCalculator,
        ])) as boolean,
    })
  }
  for (const chain of state.chains) {
    // Lighter registers here too, ahead of its Config migration in
    // manifest-activate: nothing routes to the new allocator until the solver
    // overrides point there, so a registered builder without its Config is
    // never used. TON and Gateway wait for manifest-register.
    if (CUTOVER_VM_TYPES.has(chain.vmType)) continue
    steps.push(...registrationSteps(state, chain, d[chain.builderKey]))
  }
  log(`Deployer ${deployerAccount().address}`)
  await runSteps(state, steps, dryRun)
}

// One registration per depository of the chain. The primary one keeps the
// historical step id `register <chain>`.
function registrationSteps(
  state: RedeployState,
  chain: ChainTarget,
  builder: Address
): Step[] {
  return depositoriesOf(chain).map((depository) => ({
    ...registrationStep(state, chain.id, chain.vmType, depository, builder),
    id:
      depository === chain.depository
        ? `register ${chain.id}`
        : `register ${chain.id} ${depository}`,
  }))
}

function registrationStep(
  state: RedeployState,
  chainId: string,
  vmType: string,
  depository: string,
  builder: Address
): Step {
  const client = publicClient(state.chainId)
  const encoded = encodedDepository(vmType, depository)
  return {
    id: `register ${chainId}`,
    to: state.deployed.allocator,
    abi: allocatorAbi,
    functionName: "setPayloadBuilder",
    args: [chainId, encoded, builder],
    done: async () =>
      sameAddress(
        (await client.readContract({
          abi: allocatorAbi,
          address: state.deployed.allocator,
          functionName: "payloadBuilders",
          args: [chainId, encoded],
        })) as Address,
        builder
      ),
  }
}
