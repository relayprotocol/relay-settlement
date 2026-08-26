import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Supported deposit-address-manager environment names. */
export type DepositAddressEnvironmentName = "dev" | "stag" | "prod";

const ENVIRONMENT_NAMES = new Set<DepositAddressEnvironmentName>(["dev", "stag", "prod"]);

/** Supported VM-specific Lit Action sources. */
export const VM_TYPES = [
  "ethereum-vm",
  "bitcoin-vm",
  "solana-vm",
  "hyperliquid-vm",
  "ton-vm",
  "tron-vm",
] as const;
export type VmType = (typeof VM_TYPES)[number];

/** Parsed contents of an `environments/<env>.json` config file. */
export interface DepositAddressEnvironment {
  /** Environment name; must match the filename (without `.json`). */
  name: DepositAddressEnvironmentName;
  /** Hub deposit-address manager contract address. */
  depositAddressManagerAddress: string;
  /** Hub EVM chain id that oracle attestations must reference. */
  hubEvmChainId: number;
  /** Allowlisted oracle signer addresses. */
  allowedOracles: string[];
  /** Minimum distinct oracle signatures required for a valid attestation. */
  oracleSignatureThreshold: number;
}

/**
 * Parse `--env <name>` or `--env=<name>` from CLI args. The caller decides
 * what to do when no `--env` is given (e.g. bundle-actions falls back to
 * bundling every environment, setup errors out). Returns the resolved
 * environment name (or `undefined` if absent) plus the remaining args.
 */
export function parseEnvArg(args: string[]): {
  envName: DepositAddressEnvironmentName | undefined;
  rest: string[];
} {
  const rest: string[] = [];
  let envName: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--env") {
      const value = args[++i];
      if (!value) {
        throw new Error("--env requires a value");
      }
      envName = value;
    } else if (arg.startsWith("--env=")) {
      envName = arg.slice("--env=".length);
    } else {
      rest.push(arg);
    }
  }

  if (envName !== undefined && !ENVIRONMENT_NAMES.has(envName as DepositAddressEnvironmentName)) {
    throw new Error(
      `unsupported environment: ${envName}. Supported: ${[...ENVIRONMENT_NAMES].join(", ")}`,
    );
  }
  return {
    envName: envName as DepositAddressEnvironmentName | undefined,
    rest,
  };
}

/** Load and validate the environment config at `environments/<env>.json`. */
export function loadEnvironment(envName: DepositAddressEnvironmentName): DepositAddressEnvironment {
  const candidates = [
    resolve(__dirname, "../environments", `${envName}.json`),
    resolve(process.cwd(), "environments", `${envName}.json`),
  ];

  for (const candidate of candidates) {
    try {
      const env = JSON.parse(readFileSync(candidate, "utf-8")) as DepositAddressEnvironment;
      validateEnvironment(env, candidate);
      return env;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        throw e;
      }
    }
  }
  throw new Error(`environment config not found for ${envName}`);
}

function validateEnvironment(env: DepositAddressEnvironment, path: string): void {
  if (!ENVIRONMENT_NAMES.has(env.name)) {
    throw new Error(`${path}: invalid environment name: ${env.name}`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(env.depositAddressManagerAddress)) {
    throw new Error(`${path}: depositAddressManagerAddress must be a 20-byte hex address`);
  }
  if (!Number.isInteger(env.hubEvmChainId) || env.hubEvmChainId < 0) {
    throw new Error(`${path}: hubEvmChainId must be a non-negative integer`);
  }
  if (!Array.isArray(env.allowedOracles) || env.allowedOracles.length === 0) {
    throw new Error(`${path}: allowedOracles must be a non-empty array`);
  }
  for (const oracle of env.allowedOracles) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(oracle)) {
      throw new Error(`${path}: allowedOracles entries must be 20-byte hex addresses`);
    }
  }
  if (!Number.isInteger(env.oracleSignatureThreshold) || env.oracleSignatureThreshold < 1) {
    throw new Error(`${path}: oracleSignatureThreshold must be a positive integer`);
  }
  if (env.oracleSignatureThreshold > env.allowedOracles.length) {
    throw new Error(`${path}: oracleSignatureThreshold cannot exceed allowedOracles.length`);
  }
}
