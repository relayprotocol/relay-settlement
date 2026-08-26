/**
 * Shared helpers used by the per-VM example scripts under
 * `scripts/examples/`. Keeping the boilerplate (env reading, hub trigger
 * submission, oracle attestation, ABI fragments, placeholder pricing) in one
 * place leaves each VM example focused on the VM-specific transaction
 * encoding and policy.
 */

import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  parseAbi,
  parseAbiParameters,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { generateAddress, type VmType as SdkVmType } from "@relay-protocol/settlement-sdk";
import { loadEnvironment, type DepositAddressEnvironmentName } from "../../env.js";

// ─── Env / logging ──────────────────────────────────────────────────────────

/**
 * Read an environment variable, exiting the process with a descriptive
 * error if it is missing or empty.
 */
export function requireEnv(name: string, hint: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`must set ${name} (${hint})`);
    process.exit(1);
  }
  return value;
}

/** Pretty-print a labelled section of JSON, encoding bigints as strings. */
export function logSection(title: string, body: unknown): void {
  console.log(`==> ${title}`);
  console.log(
    JSON.stringify(
      body,
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
      2,
    ),
  );
  console.log();
}

// ─── Common env shape ───────────────────────────────────────────────────────

/** Common env values consumed by every per-VM example. */
export interface CommonExampleEnv {
  envName: DepositAddressEnvironmentName;
  usageApiKey: string;
  pkpId: string;
  hubRpcUrl: string;
  hubPrivateKey: Hex;
  solverPrivateKey: Hex;
  oracleUrl: string;
}

/** Load the env values used by every per-VM example. */
export function loadCommonEnv(): CommonExampleEnv {
  return {
    envName: requireEnv("LIT_ENV", "environment name") as DepositAddressEnvironmentName,
    usageApiKey: requireEnv("LIT_USAGE_API_KEY", "Chipotle usage API key"),
    pkpId: requireEnv("LIT_PKP_ID", "PKP wallet address"),
    hubRpcUrl: requireEnv("HUB_RPC_URL", "Base hub RPC URL"),
    hubPrivateKey: requireEnv(
      "HUB_PRIVATE_KEY",
      "EVM key that submits trigger() on the Base hub (0x-prefixed)",
    ) as Hex,
    solverPrivateKey: requireEnv(
      "SOLVER_PRIVATE_KEY",
      "EVM solver key used to authorize the order",
    ) as Hex,
    oracleUrl: requireEnv("RELAY_ORACLE_URL", "oracle base URL").replace(/\/+$/, ""),
  };
}

// ─── Hub client ─────────────────────────────────────────────────────────────

/** Hub-side viem clients tied to the bundle environment's manager address. */
export interface HubClient {
  hubSigner: PrivateKeyAccount;
  hubPublicClient: PublicClient;
  hubWallet: WalletClient;
  depositAddressManagerAddress: Address;
}

/** Build the public/wallet clients used to submit `trigger()` on the hub. */
export function createHubClient(env: CommonExampleEnv): HubClient {
  const hubSigner = privateKeyToAccount(env.hubPrivateKey);
  const hubTransport = http(env.hubRpcUrl);
  const config = loadEnvironment(env.envName);
  return {
    hubSigner,
    hubPublicClient: createPublicClient({ transport: hubTransport }),
    hubWallet: createWalletClient({ account: hubSigner, transport: hubTransport }),
    depositAddressManagerAddress: config.depositAddressManagerAddress as Address,
  };
}

// ─── Solver ─────────────────────────────────────────────────────────────────

/** Solver account + the relay-protocol `ethereum-vm` virtual address. */
export interface SolverContext {
  solver: PrivateKeyAccount;
  /** Solver-side chain id used when computing the virtual solver address. */
  solverChainIdForOrder: string;
  /** Virtual solver address derived from `(solverChainId, solver.address)`. */
  solverVirtual: Address;
}

/**
 * Derive the relay-protocol `ethereum-vm` virtual solver address used in
 * `derivationFields.solver`. Defaults to `solverChainId = "10"`.
 */
export function createSolverContext(privateKey: Hex, solverChainId = "10"): SolverContext {
  const solver = privateKeyToAccount(privateKey);
  return {
    solver,
    solverChainIdForOrder: solverChainId,
    solverVirtual: generateAddress({
      family: "ethereum-vm",
      chainId: solverChainId,
      address: solver.address,
    }) as Address,
  };
}

// ─── ABI / pricing helpers ──────────────────────────────────────────────────

/** ABI for the hub `DepositAddressManager.trigger(...)` entrypoint. */
export const TRIGGER_ABI = parseAbi([
  "struct Input { string vmType; string chainId; bytes currency; uint256 amount; }",
  "struct DerivationFields { string inputVmType; string outputVmType; string outputChainId; bytes outputCurrency; bytes outputRecipient; address solver; address pricingOracle; bytes depositor; bytes refundRecipient; uint256 priceImpactBps; uint256 salt; }",
  "struct Currency { string chainId; bytes currency; }",
  "function trigger(Input input, DerivationFields derivationFields, bytes32 orderId, uint256 nonce, Currency[] currencies, bytes extraData) external",
]);

/** Encoded-prices schema embedded into the trigger's `extraData` payload. */
export const PRICES_ABI = parseAbiParameters(
  "(uint256 usdPrice, uint8 usdPriceDecimals, uint8 currencyDecimals, uint256 publishTime, uint256 expiration)[] prices",
);

/** A single placeholder price entry shaped for the prices ABI. */
export interface PlaceholderPrice {
  usdPrice: bigint;
  usdPriceDecimals: number;
  currencyDecimals: number;
  publishTime: bigint;
  expiration: bigint;
}

/**
 * Build a placeholder $1.00 price for use in dev triggers. Both sides of the
 * swap share the same price, so the action's price-impact gate reduces to
 * `outputMin / inputAmount >= 1 - priceImpactBps` (which examples control
 * via the 9900/10000 multiplier on `output.payment.minimumAmount`).
 */
export function placeholderPrice(currencyDecimals: number): PlaceholderPrice {
  return {
    usdPrice: 100_000_000n,
    usdPriceDecimals: 8,
    currencyDecimals,
    publishTime: BigInt(Math.floor(Date.now() / 1000)),
    expiration: 0xffff_ffff_ffffn,
  };
}

/** ABI-encode an array of placeholder prices for the trigger's `extraData`. */
export function encodePricesExtraData(prices: readonly PlaceholderPrice[]): Hex {
  return encodeAbiParameters(PRICES_ABI, [prices]);
}

// ─── Trigger submission ─────────────────────────────────────────────────────

/** Inputs that get passed verbatim into the hub `trigger(...)` call. */
export interface TriggerArgs {
  input: { vmType: string; chainId: string; currency: Hex; amount: bigint };
  derivationFields: {
    inputVmType: string;
    outputVmType: string;
    outputChainId: string;
    outputCurrency: Hex;
    outputRecipient: Hex;
    solver: Address;
    pricingOracle: Address;
    depositor: Hex;
    refundRecipient: Hex;
    priceImpactBps: bigint;
    salt: bigint;
  };
  orderId: Hex;
  nonce: bigint;
  currencies: readonly { chainId: string; currency: Hex }[];
  extraData: Hex;
}

/**
 * Submit `trigger(...)` on the hub `DepositAddressManager` and wait for the
 * receipt. Throws if the transaction reverts. Returns the transaction hash.
 */
export async function submitTrigger(hub: HubClient, args: TriggerArgs): Promise<Hex> {
  console.log(
    `==> submitting trigger() on hub (${hub.depositAddressManagerAddress}) from ${hub.hubSigner.address}`,
  );
  const triggerTxHash = await hub.hubWallet.writeContract({
    address: hub.depositAddressManagerAddress,
    abi: TRIGGER_ABI,
    functionName: "trigger",
    args: [
      args.input,
      args.derivationFields,
      args.orderId,
      args.nonce,
      args.currencies,
      args.extraData,
    ],
    account: hub.hubSigner,
    chain: null,
  });
  const receipt = await hub.hubPublicClient.waitForTransactionReceipt({ hash: triggerTxHash });
  if (receipt.status !== "success") {
    throw new Error(`trigger() reverted: ${triggerTxHash}`);
  }
  console.log(`==> trigger() mined: ${triggerTxHash}`);
  console.log();
  return triggerTxHash;
}

// ─── Oracle attestation ─────────────────────────────────────────────────────

/** Oracle deposit-address trigger attestation as returned by the oracle. */
export interface OracleTriggerAttestation {
  chainId: string;
  depositAddressManager: string;
  inputDepository: string;
  triggerHash: string;
  signatures: Array<{ oracleSigner: string; signature: string }>;
}

/** Inputs to the oracle attestation request. */
export interface AttestationRequest {
  input: { vmType: string; chainId: string; currency: string; amount: string };
  derivationFields: Record<string, unknown>;
  orderId: Hex;
  nonce: bigint;
  currencies: readonly { chainId: string; currency: string }[];
  prices: readonly PlaceholderPrice[];
  extraData: Hex;
}

/**
 * Request a deposit-address trigger attestation from the Relay oracle and
 * return the parsed `trigger` payload. Throws on non-2xx responses.
 */
export async function requestAttestation(
  oracleUrl: string,
  args: AttestationRequest,
): Promise<OracleTriggerAttestation> {
  const res = await fetch(`${oracleUrl}/attestations/deposit-address-triggers/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: args.input,
      derivationFields: args.derivationFields,
      orderId: args.orderId,
      nonce: args.nonce.toString(),
      currencies: args.currencies,
      prices: args.prices.map((p) => ({
        usdPrice: p.usdPrice.toString(),
        usdPriceDecimals: p.usdPriceDecimals,
        currencyDecimals: p.currencyDecimals,
        publishTime: p.publishTime.toString(),
        expiration: p.expiration.toString(),
      })),
      extraData: args.extraData,
      requestPeerSignatures: true,
    }),
  });
  if (!res.ok) {
    throw new Error(`oracle attestation failed (HTTP ${res.status}): ${await res.text()}`);
  }
  const { trigger } = (await res.json()) as { trigger: OracleTriggerAttestation };
  logSection("oracle attestation", trigger);
  return trigger;
}

// ─── SDK chains config helper ───────────────────────────────────────────────

/**
 * Build a `chainsConfig` mapping suitable for `getOrderId(...)`. Combines a
 * VM-specific entry for the input chain with the standard ethereum-vm slugs
 * used across hub/destination chains.
 */
export function buildChainsConfig(
  inputChainSlug: string,
  inputVmType: SdkVmType,
): Record<string, SdkVmType> {
  return {
    [inputChainSlug]: inputVmType,
    "1": "ethereum-vm",
    "10": "ethereum-vm",
    "8453": "ethereum-vm",
    "42161": "ethereum-vm",
    "137": "ethereum-vm",
    ethereum: "ethereum-vm",
    optimism: "ethereum-vm",
    base: "ethereum-vm",
    arbitrum: "ethereum-vm",
    polygon: "ethereum-vm",
  };
}
