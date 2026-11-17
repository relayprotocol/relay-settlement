import type { NetworkConfig } from "./types"

/** Resolve the endpoint and its provenance together, using existing env semantics. */
export function resolveRpc(
  override: string | undefined,
  defaults: NetworkConfig["rpc"]
): Pick<NetworkConfig, "rpc" | "usesDefaultRpc"> {
  return {
    rpc: override ? [override] : defaults,
    usesDefaultRpc: !override && defaults.some((url) => Boolean(url.trim())),
  }
}
