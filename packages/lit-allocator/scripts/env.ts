import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Supported allocator environment names. */
export type AllocatorEnvironmentName = "dev" | "stag" | "prod";

const ENVIRONMENT_NAMES = new Set<AllocatorEnvironmentName>(["dev", "stag", "prod"]);

/** Parsed contents of an `environments/<env>.json` config file. */
export interface AllocatorEnvironment {
  /** Environment name; must match the filename (without `.json`). */
  name: AllocatorEnvironmentName;
  /** Hub allocator contract address. */
  allocatorAddress: string;
  /** Hub EVM chain id that oracle attestations must reference. */
  hubEvmChainId: number;
  /** Allowlisted oracle signer addresses. */
  allowedOracles: string[];
  /** Minimum distinct oracle signatures required for a valid attestation. */
  oracleSignatureThreshold: number;
  /** Lighter gateway contract address on the gateway chain. */
  lighterGateway: string;
  /** EIP-155 gateway chain id used for Lighter ChangePubKey transactions. */
  lighterGatewayChainId: number;
  /** Lighter API keys the Lighter action may register via ChangePubKey. */
  lighterAllowedApiKeys?: Array<{
    apiKeyIndex: number;
    publicKey: string;
  }>;
}

/**
 * Parse `--env <name>` or `--env=<name>` from CLI args. The caller decides
 * what to do when no `--env` is given. Returns the resolved environment name
 * (or `undefined` if absent) plus the remaining args.
 */
export function parseEnvArg(args: string[]): {
  envName: AllocatorEnvironmentName | undefined;
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

  if (envName !== undefined && !ENVIRONMENT_NAMES.has(envName as AllocatorEnvironmentName)) {
    throw new Error(
      `unsupported environment: ${envName}. Supported: ${[...ENVIRONMENT_NAMES].join(", ")}`,
    );
  }
  return { envName: envName as AllocatorEnvironmentName | undefined, rest };
}

/** Load and validate the environment config at `environments/<env>.json`. */
export function loadEnvironment(envName: AllocatorEnvironmentName): AllocatorEnvironment {
  const candidates = [
    resolve(__dirname, "../environments", `${envName}.json`),
    resolve(process.cwd(), "environments", `${envName}.json`),
  ];

  for (const candidate of candidates) {
    try {
      const env = JSON.parse(readFileSync(candidate, "utf-8")) as AllocatorEnvironment;
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

function validateEnvironment(env: AllocatorEnvironment, path: string): void {
  if (!ENVIRONMENT_NAMES.has(env.name)) {
    throw new Error(`${path}: invalid environment name: ${env.name}`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(env.allocatorAddress)) {
    throw new Error(`${path}: allocatorAddress must be a 20-byte hex address`);
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
  if (!/^0x[0-9a-fA-F]{40}$/.test(env.lighterGateway)) {
    throw new Error(`${path}: lighterGateway must be a 20-byte hex address`);
  }
  if (!Number.isInteger(env.lighterGatewayChainId) || env.lighterGatewayChainId < 1) {
    throw new Error(`${path}: lighterGatewayChainId must be a positive integer`);
  }
  if (env.lighterAllowedApiKeys !== undefined) {
    if (!Array.isArray(env.lighterAllowedApiKeys)) {
      throw new Error(`${path}: lighterAllowedApiKeys must be an array`);
    }
    for (const key of env.lighterAllowedApiKeys) {
      if (!Number.isInteger(key.apiKeyIndex) || key.apiKeyIndex < 0 || key.apiKeyIndex > 255) {
        throw new Error(`${path}: lighterAllowedApiKeys[].apiKeyIndex must be a uint8`);
      }
      const publicKey = key.publicKey.startsWith("0x") ? key.publicKey.slice(2) : key.publicKey;
      if (
        !/^[0-9a-fA-F]*$/.test(publicKey) ||
        publicKey.length === 0 ||
        publicKey.length % 2 !== 0
      ) {
        throw new Error(`${path}: lighterAllowedApiKeys[].publicKey must be non-empty hex`);
      }
    }
  }
}

/** Supported VM-specific Lit Action sources. */
export const VM_TYPES = [
  "ethereum-vm",
  "tron-vm",
  "solana-vm",
  "ton-vm",
  "bitcoin-vm",
  "hyperliquid-vm",
  "lighter-vm",
  "xrp-vm",
] as const;
export type VmType = (typeof VM_TYPES)[number];

const ACTION_BASENAMES: Record<VmType, string> = {
  "ethereum-vm": "ethereum",
  "bitcoin-vm": "bitcoin",
  "tron-vm": "tron",
  "solana-vm": "solana",
  "ton-vm": "ton",
  "hyperliquid-vm": "hyperliquid",
  "lighter-vm": "lighter",
  "xrp-vm": "xrp",
};

/** Map a VmType to the `src/vm/*.ts` entry / bundle output basename. */
export function actionBasenameForVm(vmType: VmType): string {
  return ACTION_BASENAMES[vmType];
}
