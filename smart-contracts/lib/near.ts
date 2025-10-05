import { JsonRpcProvider } from "@near-js/providers"
import { networks } from "@relay-protocol/networks"
import { fromHex } from "viem"

// default values are Aurora testnet
const { near: nearNetwork } = networks["1313161555"]

export async function derivePublicKey(
  path: string,
  predecessor: string,
  domainId: number,
  signerContractId: string = nearNetwork!.signer,
  rpcUrl: string = nearNetwork!.rpc
): Promise<{ curve: string; publicKey: string }> {
  // Create a connection to the specified RPC
  const provider = new JsonRpcProvider({
    url: rpcUrl,
  })

  const args = {
    domain_id: domainId,
    path,
    predecessor,
  }

  const args_base64 = Buffer.from(JSON.stringify(args)).toString("base64")
  const result = await provider.query({
    account_id: signerContractId,
    args_base64,
    finality: "optimistic",
    method_name: "derived_public_key",
    request_type: "call_function",
  })

  const response = Buffer.from(result.result)
  const res = JSON.parse(Buffer.from(response).toString())
  const [curve, publicKey] = res.split(":")
  return { curve, publicKey }
}

// A function that extracts the r, s, and v values from a NEAR signature
export const extractNearSignature = (
  signature: string
): { r: string; s: string; v: number } => {
  const jsonSignature = JSON.parse(fromHex(signature, "string"))

  const {
    big_r: { affine_point },
    s: { scalar },
    recovery_id,
  } = jsonSignature

  const r = affine_point.substring(2)
  const s = scalar
  const v = recovery_id + 27 // Convert to 0 or 1 for EIP-1559 compatibility
  return { r, s, v }
}
