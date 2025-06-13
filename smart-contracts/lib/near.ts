import { fromHex } from 'viem'

// A function that extracts the r, s, and v values from a NEAR signature
export const extractNearSignature = (
  signature: string
): { r: string; s: string; v: number } => {
  const jsonSignature = JSON.parse(fromHex(signature, 'string'))

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
