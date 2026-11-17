// Preserve manifest indices in signature artifacts even when executing a subset.
export function executionIndices(count: number, selection?: string): number[] {
  if (selection === undefined) return Array.from({ length: count }, (_, i) => i)
  if (!/^\d+(,\d+)*$/.test(selection))
    throw new Error("--indices must be comma-separated zero-based indices")
  const indices = selection.split(",").map(Number)
  if (
    new Set(indices).size !== indices.length ||
    indices.some((i) => !Number.isSafeInteger(i) || i >= count)
  ) {
    throw new Error("--indices contains duplicate or out-of-range entries")
  }
  return indices.sort((a, b) => a - b)
}
