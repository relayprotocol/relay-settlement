import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Supported allocator environment names. */
export type AllocatorEnvironmentName = "dev" | "stag" | "prod" | "test";

const ENVIRONMENT_NAMES = new Set<AllocatorEnvironmentName>(["dev", "stag", "prod", "test"]);

/**
 * Version label of the actions this source tree builds, per environment.
 * Registered action names carry it so several versions can coexist in one Lit
 * account. The redeployed dev, stag, prod and test allocators are signed by
 * `v3`; `v2` keeps signing for each environment's previous allocator. Bump an entry
 * whenever a release must live alongside the previous one.
 */
export const ACTION_VERSIONS: Record<AllocatorEnvironmentName, string> = {
  dev: "v3",
  stag: "v3",
  prod: "v3",
  test: "v3",
};

/** One Lighter deployment the Lighter action may register API keys on. */
export interface LighterGatewayConfig {
  /** EIP-155 chain id of the L1 that hosts this Lighter gateway. */
  chainId: number;
  /** ZkLighter gateway contract address on that L1. */
  gateway: string;
  /** API keys this action may register on this gateway via ChangePubKey. May be empty (fail-closed). */
  allowedApiKeys: Array<{
    apiKeyIndex: number;
    publicKey: string;
  }>;
}

/** Deployment-specific fields of the Atlas EIP-712 signing domain. */
export interface AtlasDomainConfig {
  /** EIP-712 domain `chainId` of the Atlas deployment (not an EVM network id). */
  chainId: number;
  /** EIP-712 domain `salt` of the Atlas deployment. */
  salt: string;
}

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
  /** Lighter deployments reachable from this environment (omit when Lighter isn't supported). */
  lighterGateways?: LighterGatewayConfig[];
  /** Atlas transaction signing domain (omit when Atlas isn't supported). */
  atlasDomain?: AtlasDomainConfig;
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
      const env = JSON.parse(readFileSync(candidate, "utf-8")) as unknown;
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

const EVM_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
const LEGACY_LIGHTER_FIELDS = ["lighterGateway", "lighterGatewayChainId", "lighterAllowedApiKeys"];

export function validateEnvironment(
  input: unknown,
  path: string,
): asserts input is AllocatorEnvironment {
  const env = input as AllocatorEnvironment & Record<string, unknown>;
  if (!ENVIRONMENT_NAMES.has(env.name)) {
    throw new Error(`${path}: invalid environment name: ${env.name}`);
  }
  if (!EVM_ADDRESS_REGEX.test(env.allocatorAddress)) {
    throw new Error(`${path}: allocatorAddress must be a 20-byte hex address`);
  }
  if (!Number.isInteger(env.hubEvmChainId) || env.hubEvmChainId < 0) {
    throw new Error(`${path}: hubEvmChainId must be a non-negative integer`);
  }
  if (!Array.isArray(env.allowedOracles) || env.allowedOracles.length === 0) {
    throw new Error(`${path}: allowedOracles must be a non-empty array`);
  }
  for (const oracle of env.allowedOracles) {
    if (!EVM_ADDRESS_REGEX.test(oracle)) {
      throw new Error(`${path}: allowedOracles entries must be 20-byte hex addresses`);
    }
  }
  if (!Number.isInteger(env.oracleSignatureThreshold) || env.oracleSignatureThreshold < 1) {
    throw new Error(`${path}: oracleSignatureThreshold must be a positive integer`);
  }
  if (env.oracleSignatureThreshold > env.allowedOracles.length) {
    throw new Error(`${path}: oracleSignatureThreshold cannot exceed allowedOracles.length`);
  }

  for (const legacyField of LEGACY_LIGHTER_FIELDS) {
    if (env[legacyField] !== undefined) {
      throw new Error(`${path}: ${legacyField} is no longer supported; use lighterGateways`);
    }
  }
  if (env.lighterGateways !== undefined) {
    if (!Array.isArray(env.lighterGateways) || env.lighterGateways.length === 0) {
      throw new Error(`${path}: lighterGateways must be a non-empty array`);
    }
    const seenChainIds = new Set<number>();
    for (const gateway of env.lighterGateways) {
      if (!Number.isInteger(gateway.chainId) || gateway.chainId < 1) {
        throw new Error(`${path}: lighterGateways[].chainId must be a positive integer`);
      }
      if (seenChainIds.has(gateway.chainId)) {
        throw new Error(`${path}: lighterGateways[].chainId must be unique`);
      }
      seenChainIds.add(gateway.chainId);
      if (!EVM_ADDRESS_REGEX.test(gateway.gateway)) {
        throw new Error(`${path}: lighterGateways[].gateway must be a 20-byte hex address`);
      }
      if (!Array.isArray(gateway.allowedApiKeys)) {
        throw new Error(`${path}: lighterGateways[].allowedApiKeys must be an array`);
      }
      for (const key of gateway.allowedApiKeys) {
        if (!Number.isInteger(key.apiKeyIndex) || key.apiKeyIndex < 0 || key.apiKeyIndex > 255) {
          throw new Error(
            `${path}: lighterGateways[].allowedApiKeys[].apiKeyIndex must be a uint8`,
          );
        }
        const publicKey = key.publicKey.startsWith("0x") ? key.publicKey.slice(2) : key.publicKey;
        if (
          !/^[0-9a-fA-F]*$/.test(publicKey) ||
          publicKey.length === 0 ||
          publicKey.length % 2 !== 0
        ) {
          throw new Error(
            `${path}: lighterGateways[].allowedApiKeys[].publicKey must be non-empty hex`,
          );
        }
      }
    }
  }
  if (env.atlasDomain !== undefined) {
    if (typeof env.atlasDomain !== "object" || env.atlasDomain === null) {
      throw new Error(`${path}: atlasDomain must be an object`);
    }
    if (!Number.isSafeInteger(env.atlasDomain.chainId) || env.atlasDomain.chainId < 1) {
      throw new Error(`${path}: atlasDomain.chainId must be a positive integer`);
    }
    if ("verifyingContract" in env.atlasDomain) {
      throw new Error(
        `${path}: atlasDomain.verifyingContract is no longer supported; use atlasDomain.salt`,
      );
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(env.atlasDomain.salt)) {
      throw new Error(`${path}: atlasDomain.salt must be a 32-byte hex value`);
    }
  }
}

/** Supported VM-specific Lit Action sources. */
export const VM_TYPES = [
  "gateway-vm",
  "ethereum-vm",
  "tron-vm",
  "solana-vm",
  "ton-vm",
  "bitcoin-vm",
  "hyperliquid-vm",
  "lighter-vm",
  "xrp-vm",
  "hedera-vm",
  "atlas-vm",
] as const;
export type VmType = (typeof VM_TYPES)[number];

const ACTION_BASENAMES: Record<VmType, string> = {
  "gateway-vm": "gateway",
  "ethereum-vm": "ethereum",
  "bitcoin-vm": "bitcoin",
  "tron-vm": "tron",
  "solana-vm": "solana",
  "ton-vm": "ton",
  "hyperliquid-vm": "hyperliquid",
  "lighter-vm": "lighter",
  "xrp-vm": "xrp",
  "hedera-vm": "hedera",
  "atlas-vm": "atlas",
};

/** Map a VmType to the `src/vm/*.ts` entry / bundle output basename. */
export function actionBasenameForVm(vmType: VmType): string {
  return ACTION_BASENAMES[vmType];
}
