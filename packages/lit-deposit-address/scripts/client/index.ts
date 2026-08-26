/**
 * Helpers for invoking the bundled Lit Deposit Address action via the
 * Chipotle REST API.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DepositAddressEnvironmentName, VmType } from "../env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default Chipotle REST API base URL. */
export const DEFAULT_BASE_URL = "https://api.chipotle.litprotocol.com";

/** Configuration required to invoke the deposit-address action. */
export interface DepositAddressesClient {
  /** Chipotle API base URL. */
  apiBaseUrl: string;
  /** Usage API key for authentication. */
  apiKey: string;
  /** PKP wallet address whose private key the action should use inside the TEE. */
  pkpId: string;
  /** Environment name; used to locate the matching bundled action file. */
  envName: DepositAddressEnvironmentName;
  /** VM family whose bundled action file should be loaded for this call. */
  vmType: VmType;
}

/** Raw Chipotle response from `/lit_action`. */
interface LitActionApiResponse {
  response: string;
  logs?: string;
}

/** Cached bundled action source so repeated calls don't re-read the file. */
const actionCodeCache = new Map<string, string>();

/** Add the client-owned PKP id exactly as it will be sent to the Lit Action. */
export function buildLitActionJsParams(
  client: DepositAddressesClient,
  jsParams: Record<string, unknown>,
): Record<string, unknown> {
  return { ...jsParams, pkpId: client.pkpId };
}

/** Locate and read the bundled per-VM action file for an environment from disk. */
function loadBundledActionFile(envName: DepositAddressEnvironmentName, vmType: VmType): string {
  const cacheKey = `${envName}:${vmType}`;
  const cached = actionCodeCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const filename = `${vmType}.js`;
  const candidates = [
    resolve(__dirname, "../../actions", envName, filename),
    resolve(__dirname, "../../dist/actions", envName, filename),
    resolve(process.cwd(), "dist/actions", envName, filename),
  ];
  for (const candidate of candidates) {
    try {
      const code = readFileSync(candidate, "utf-8");
      actionCodeCache.set(cacheKey, code);
      return code;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        throw e;
      }
    }
  }
  throw new Error(
    `bundled ${vmType} action file not found for ${envName}. Run \`yarn bundle:actions -- --env ${envName}\` first.`,
  );
}

/**
 * Execute the deposit-address Lit Action with the supplied `jsParams` and
 * return its parsed JSON response. Throws on HTTP errors and on action-side
 * `"Error: ..."` strings.
 */
export async function executeLitAction(
  client: DepositAddressesClient,
  jsParams: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${client.apiBaseUrl}/core/v1/lit_action`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": client.apiKey },
    body: JSON.stringify({
      js_params: buildLitActionJsParams(client, jsParams),
      code: loadBundledActionFile(client.envName, client.vmType),
    }),
  });

  if (!res.ok) {
    throw new Error(`Lit Action execution failed (HTTP ${res.status}): ${await res.text()}`);
  }

  const data = (await res.json()) as LitActionApiResponse;
  const response = typeof data.response === "string" ? JSON.parse(data.response) : data.response;

  if (typeof response === "string" && response.startsWith("Error:")) {
    throw new Error(response);
  }
  return response;
}
