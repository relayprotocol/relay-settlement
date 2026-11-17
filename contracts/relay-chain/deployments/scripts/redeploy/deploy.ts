import { execFileSync } from "child_process"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { getAddress, type Address } from "viem"

import {
  deployerAccount,
  hasCode,
  loadState,
  log,
  publicClient,
  requireChainId,
  resolveIdempotencyStore,
  rpcUrl,
  saveState,
  usesStandaloneStore,
  WORKSPACE_ROOT,
  type Env,
  type RedeployState,
} from "./common"

type Recipe = {
  // Foundry script under script/
  script: string
  env: (state: RedeployState) => Record<string, string>
}

const need = (value: string | undefined, label: string): string => {
  if (!value) throw new Error(`Missing ${label}; run --phase deploy in order`)
  return value
}

// Deploy order follows the immutables: the multisig before the allocator, the
// allocator before the executor and the TON builder, the executor before the
// pool draw resolver. OWNER/ADMIN default to the deployer; --phase handover
// moves them to the council. The inbox takes the live oracle's idempotency
// store, which is not redeployed (see the README).
export const CORE: Record<string, Recipe> = {
  inboxMultisig: {
    script: "DeployOracleMultisig.s.sol",
    env: (s) => ({
      SIGNERS: s.inputs.multisigSigners.join(","),
      THRESHOLD: s.inputs.multisigThreshold,
    }),
  },
  inbox: {
    script: "DeployRelayInbox.s.sol",
    env: (s) => ({
      HUB: s.hub,
      IDEMPOTENCY_STORE: need(
        resolveIdempotencyStore(s),
        "idempotency store (shared from --phase inventory, or the standalone store deployed first)"
      ),
    }),
  },
  allocator: {
    script: "DeployAllocator.s.sol",
    env: (s) => ({
      HUB: s.hub,
      ORACLE: need(s.deployed.inboxMultisig, "multisig"),
    }),
  },
  executor: {
    script: "DeployRelayExecutor.s.sol",
    env: (s) => ({
      HUB: s.hub,
      ALLOCATOR: need(s.deployed.allocator, "allocator"),
    }),
  },
  poolDrawResolver: {
    script: "DeployPoolDrawResolver.s.sol",
    env: (s) => ({
      HUB: s.hub,
      EXECUTOR: need(s.deployed.executor, "executor"),
    }),
  },
  genericMapping: {
    script: "DeployGenericMapping.s.sol",
    env: (s) => ({
      LEGACY: need(s.previous.genericMapping, "previous genericMapping"),
    }),
  },
}

// Standalone mode only: a fresh idempotency store for the new inbox, deployed
// before it so the inbox constructor can take it. The deployer admins it (ADMIN
// defaults to the deployer in forgeEnv); --phase handover moves its ADMIN_ROLE
// to the council, which grants the inbox WRITE_ROLE in --phase manifest-activate.
export const IDEMPOTENCY_STORE_RECIPE: Recipe = {
  script: "DeployRelayInboxIdempotencyStore.s.sol",
  env: () => ({}),
}

export const BUILDERS: Record<string, Recipe> = {
  ethereumVmPayloadBuilder: {
    script: "DeployEthereumVmPayloadBuilder.s.sol",
    env: (s) => ({ CONFIG: s.config }),
  },
  solanaVmPayloadBuilder: {
    script: "DeploySolanaVmPayloadBuilder.s.sol",
    env: (s) => ({ CONFIG: s.config }),
  },
  tronVmPayloadBuilder: {
    script: "DeployTronVmPayloadBuilder.s.sol",
    env: (s) => ({ CONFIG: s.config }),
  },
  lighterVmPayloadBuilder: {
    script: "DeployLighterVmPayloadBuilder.s.sol",
    env: (s) => ({ CONFIG: s.config }),
  },
  atlasVmPayloadBuilder: {
    script: "DeployAtlasVmPayloadBuilder.s.sol",
    env: (s) => ({ CONFIG: s.config }),
  },
  bitcoinVmPayloadBuilder: {
    script: "DeployBitcoinVmPayloadBuilder.s.sol",
    env: (s) => ({
      CONFIG: s.config,
      ALLOCATOR_CHANGE_SCRIPT: need(
        s.inputs.bitcoinChangeScript,
        "bitcoin change script"
      ),
    }),
  },
  hyperliquidVmPayloadBuilder: {
    script: "DeployHyperliquidVmPayloadBuilder.s.sol",
    env: (s) => ({
      CONFIG: s.config,
      SIGNATURE_CHAIN_ID: need(
        s.inputs.hyperliquidSignatureChainId,
        "hyperliquid signature chain id"
      ),
      HYPERLIQUID_CHAIN: need(s.inputs.hyperliquidChain, "hyperliquid chain"),
    }),
  },
  tonVmPayloadBuilder: {
    script: "DeployTonVmPayloadBuilder.s.sol",
    env: (s) => ({
      CONFIG: s.config,
      ALLOCATOR: need(s.deployed.allocator, "allocator"),
      CHAIN_ID: need(s.inputs.tonChainId, "ton chain id"),
      SUBWALLET_ID: need(s.inputs.tonSubwalletId, "ton subwallet id"),
      TIMEOUT: need(s.inputs.tonTimeout, "ton timeout"),
    }),
  },
  xrpVmPayloadBuilder: {
    script: "DeployXrpVmPayloadBuilder.s.sol",
    env: (s) => ({
      SIGNING_PUBKEY: need(s.inputs.xrpSigningPubkey, "xrp signing pubkey"),
    }),
  },
  hederaVmPayloadBuilder: {
    script: "DeployHederaVmPayloadBuilder.s.sol",
    env: (s) => ({
      TOKEN_NUM: need(s.inputs.hederaTokenNum, "hedera token num"),
    }),
  },
  gatewayEthereumVmDestinationPayloadBuilder: {
    script: "DeployGatewayEthereumVmDestinationPayloadBuilder.s.sol",
    env: (s) => ({ CONFIG: s.config }),
  },
  gatewayVmPayloadBuilder: {
    script: "DeployGatewayVmPayloadBuilder.s.sol",
    env: (s) => ({ CONFIG: s.config }),
  },
}

// Builders this environment needs, from its chain list. Gateway chains also
// need the destination builder that the Gateway builder points at.
export function requiredBuilders(state: RedeployState): string[] {
  const keys = new Set(state.chains.map((chain) => chain.builderKey))
  if (keys.has("gatewayVmPayloadBuilder")) {
    keys.add("gatewayEthereumVmDestinationPayloadBuilder")
  }
  return Object.keys(BUILDERS).filter((key) => keys.has(key))
}

// Every recipe is a forge script, which reads DEPLOYER_PRIVATE_KEY from the
// child env: the key never appears in argv, where any local process can read it.
export const forgeScriptArgs = (recipe: Recipe, rpc: string) => [
  "script",
  `script/${recipe.script}`,
  "--broadcast",
  "--rpc-url",
  rpc,
]

// Every input the deploy scripts read (vm.env*, _requireEnvAddress,
// _envAddressOrDeployer). None is inherited from the operator's shell: a
// stray OWNER or ADMIN would otherwise own or administer a new contract.
const SCRIPT_INPUTS = [
  "ADMIN",
  "ALLOCATOR",
  "ALLOCATOR_CHANGE_SCRIPT",
  "CHAIN_ID",
  "CONFIG",
  "EXECUTOR",
  "HUB",
  "HYPERLIQUID_CHAIN",
  "IDEMPOTENCY_STORE",
  "LEGACY",
  "ORACLE",
  "OWNER",
  "SIGNATURE_CHAIN_ID",
  "SIGNERS",
  "SIGNING_PUBKEY",
  "SUBWALLET_ID",
  "THRESHOLD",
  "TIMEOUT",
  "TOKEN_NUM",
]

// The child env of one forge script: the inherited env without any script
// input, the recipe's inputs, and OWNER and ADMIN set to the deployer, which
// hands every contract to the council in --phase handover.
export function forgeEnv(
  state: RedeployState,
  recipe: Recipe
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of SCRIPT_INPUTS) delete env[name]
  const deployer = deployerAccount().address
  return { ...env, OWNER: deployer, ADMIN: deployer, ...recipe.env(state) }
}

function runForge(state: RedeployState, name: string, recipe: Recipe): Address {
  const env = forgeEnv(state, recipe)
  const rpc = rpcUrl(state.chainId)
  execFileSync("forge", forgeScriptArgs(recipe, rpc), {
    cwd: WORKSPACE_ROOT,
    env,
    stdio: "inherit",
  })
  const broadcast = JSON.parse(
    readFileSync(
      join(
        WORKSPACE_ROOT,
        "broadcast",
        recipe.script,
        String(state.chainId),
        "run-latest.json"
      ),
      "utf8"
    )
  )
  const created = broadcast.transactions.filter(
    (tx: { transactionType: string }) => tx.transactionType === "CREATE"
  )
  if (created.length !== 1) {
    throw new Error(
      `${name}: expected one CREATE in ${recipe.script}, found ${created.length}`
    )
  }
  return getAddress(created[0].contractAddress)
}

export async function deploy(env: Env, dryRun: boolean) {
  const state = loadState(env)
  const client = publicClient(state.chainId)
  await requireChainId(client, state.chainId)
  log(`Deployer ${deployerAccount().address}`)

  const plan: [string, Recipe][] = [
    // Standalone mode: deploy the fresh store first, so the inbox can take it
    ...(usesStandaloneStore(env)
      ? ([["inboxIdempotencyStore", IDEMPOTENCY_STORE_RECIPE]] as [
          string,
          Recipe,
        ][])
      : []),
    ...Object.entries(CORE),
    ...requiredBuilders(state).map(
      (key) => [key, BUILDERS[key]] as [string, Recipe]
    ),
  ]
  // Fail before broadcasting anything if a recipe points at a missing script
  for (const [name, recipe] of plan) {
    const path = join(WORKSPACE_ROOT, "script", recipe.script)
    if (!existsSync(path)) throw new Error(`${name}: ${path} not found`)
  }
  for (const [name, recipe] of plan) {
    const existing = state.deployed[name]
    if (existing && hasCode(await client.getCode({ address: existing }))) {
      log(`  ✓ ${name} ${existing}`)
      continue
    }
    if (dryRun) {
      let inputs: string
      try {
        inputs = JSON.stringify(recipe.env(state))
      } catch {
        inputs = "(inputs resolved once its dependencies are deployed)"
      }
      log(`  would deploy ${name} ${inputs}`)
      continue
    }
    log(`\n==> ${name}`)
    state.deployed[name] = runForge(state, name, recipe)
    saveState(state)
    log(`  → ${state.deployed[name]}`)
  }
}
