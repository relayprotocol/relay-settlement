/**
 * Helpers for invoking the bundled Lit Allocator actions via the Chipotle
 * REST API.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { actionBasenameForVm, type AllocatorEnvironmentName, type VmType } from "../env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Chipotle REST API base URL. */
export const CHIPOTLE_API_BASE_URL = "https://api.chipotle.litprotocol.com";

/** Configuration required to invoke an allocator action. */
export interface AllocatorClient {
  /** Chipotle API base URL. */
  apiBaseUrl: string;
  /** Usage API key for authentication. */
  apiKey: string;
  /** PKP wallet address whose private key the action should use inside the TEE. */
  pkpId: string;
  /** Environment whose bundled action files to load. */
  envName: AllocatorEnvironmentName;
}

/** Raw Chipotle response from `/lit_action`. */
interface LitActionApiResponse {
  response: string;
  logs?: string;
}

/** Cached bundled action source so repeated calls don't re-read the file. */
const actionCodeCache = new Map<string, string>();

/** Locate and read the bundled action file for a (env, vm) pair from disk. */
function loadBundledActionFile(envName: AllocatorEnvironmentName, vmType: VmType): string {
  const cacheKey = `${envName}:${vmType}`;
  const cached = actionCodeCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const basename = actionBasenameForVm(vmType);
  const candidates = [
    resolve(__dirname, "../../actions", envName, `${basename}.js`),
    resolve(__dirname, "../../dist/actions", envName, `${basename}.js`),
    resolve(process.cwd(), "dist/actions", envName, `${basename}.js`),
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
    `bundled ${vmType} action not found for ${envName}. ` +
      `Run \`npm run bundle:actions -- --env ${envName}\` first.`,
  );
}

/**
 * Execute one of the per-VM allocator Lit Actions with the supplied
 * `jsParams` and return its parsed JSON response. Throws on HTTP errors and
 * on action-side `"Error: ..."` strings.
 */
export async function executeLitAction(
  client: AllocatorClient,
  vmType: VmType,
  jsParams: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${client.apiBaseUrl}/core/v1/lit_action`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": client.apiKey },
    body: JSON.stringify({
      js_params: { pkpId: client.pkpId, ...jsParams },
      code: loadBundledActionFile(client.envName, vmType),
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
