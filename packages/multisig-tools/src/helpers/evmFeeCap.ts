import type { PublicClient } from "viem"

export async function assertEvmFeeCap(
  client: Pick<PublicClient, "getBlock">,
  maxFeePerGas?: bigint
) {
  if (maxFeePerGas === undefined) return
  const { baseFeePerGas } = await client.getBlock({ blockTag: "latest" })
  if (baseFeePerGas !== null && baseFeePerGas > maxFeePerGas) {
    throw new Error(
      `Stale EIP-1559 fee cap: approved maxFeePerGas ${maxFeePerGas} is below the current base fee ${baseFeePerGas}. Wait for fees to fall, or regenerate the transaction with a higher cap and obtain a new Safe approval and MPC signature; changing fees changes the signing hash.`
    )
  }
}
