import { JsonRpcProvider } from "@near-js/providers"
import { networks } from "@relay-protocol/settlement-networks"
import { fromHex } from "viem"

// default values are Aurora testnet
const { near: nearNetwork } = networks["1313161554"]

export async function derivePublicKey(
  path: string,
  predecessor: string,
  domainId: number,
  signerContractId: string = nearNetwork!.signer,
  rpcUrl: string = nearNetwork!.rpc
): Promise<{ curve: string; publicKey: string }> {
  const provider = new JsonRpcProvider({
    url: rpcUrl,
  })

  const args = {
    domain_id: domainId,
    path,
    predecessor,
  }

  const args_base64 = Buffer.from(JSON.stringify(args)).toString("base64")
  const result = (await provider.query({
    account_id: signerContractId,
    args_base64,
    finality: "optimistic",
    method_name: "derived_public_key",
    request_type: "call_function",
  })) as unknown as { result: number[] }

  const response = Buffer.from(result.result)
  const res = JSON.parse(Buffer.from(response).toString())
  const [curve, publicKey] = res.split(":")
  return { curve, publicKey }
}

// Extracts the r, s, and v values from a NEAR ECDSA signature.
export const extractNearSignature = (
  signature: string
): { r: string; s: string; v: number } => {
  const jsonSignature = JSON.parse(
    fromHex(signature as `0x${string}`, "string")
  )

  const {
    big_r: { affine_point },
    s: { scalar },
    recovery_id,
  } = jsonSignature

  const r = affine_point.substring(2)
  const s = scalar
  const v = recovery_id + 27
  return { r, s, v }
}
