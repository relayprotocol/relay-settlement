import type { Provider } from "ethers"

export const getBlockTimestamp = async (
  provider: Provider,
  cache: Map<number, number>,
  blockNumber: number
) => {
  const cached = cache.get(blockNumber)
  if (cached !== undefined) {
    return cached
  }

  const block = await provider.getBlock(blockNumber)
  if (!block) {
    throw new Error(`Block not found: ${blockNumber}`)
  }

  const timestamp = block.timestamp
  cache.set(blockNumber, timestamp)
  return timestamp
}
