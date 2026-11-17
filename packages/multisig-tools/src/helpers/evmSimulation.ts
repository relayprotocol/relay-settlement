import type { Address, Hex, PublicClient } from "viem"

type SimulationCall = {
  from: Address
  to: Address
  data: Hex
  value: bigint
  gas?: bigint
  nonce?: number
}

// eth_simulateV1 carries storage changes between calls without broadcasting.
// No token balances or contract storage are overridden to force success.
export async function simulateEvmSequence(
  client: Pick<PublicClient, "simulateBlocks">,
  calls: SimulationCall[],
  blockNumber?: bigint
) {
  const blocks = await client.simulateBlocks({
    blockNumber,
    blocks: [{ calls }],
    validation: false,
  })
  const results = blocks[0]?.calls
  if (!results || results.length !== calls.length) {
    throw new Error("Sequential EVM simulation returned an incomplete result")
  }
  for (const [index, result] of results.entries()) {
    if (result.status !== "success") {
      throw new Error(
        `Sequential EVM simulation failed at transaction ${index + 1}: ${result.error?.message}`
      )
    }
    if (result.gasUsed <= 0n) {
      throw new Error("Sequential EVM simulation returned invalid gas usage")
    }
  }
  return results
}
