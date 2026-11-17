// ABOUTME: Canonical Atlas asset id codec — asset ids as decimal uint32 strings,
// ABOUTME: shared by the atlas-vm cases in utils.ts (accounts are 20-byte addresses).

// Atlas signs asset ids as uint32; they still fill a 16-byte currency slot
export const ATLAS_ASSET_ID_MAX = (1n << 32n) - 1n

// Canonical form: decimal digits, no leading zeros, sign, whitespace or prefix
const ATLAS_ASSET_ID_REGEX = /^(0|[1-9][0-9]*)$/

/** Parses a canonical Atlas asset id; other spellings are rejected so an id has exactly one. */
export const parseAtlasAssetId = (value: string): bigint => {
  if (!ATLAS_ASSET_ID_REGEX.test(value)) {
    throw new Error(
      `Invalid Atlas asset id "${value}": expected a canonical decimal integer (e.g. 2)`
    )
  }

  const id = BigInt(value)
  if (id > ATLAS_ASSET_ID_MAX) {
    throw new Error(
      `Invalid Atlas asset id "${value}": exceeds the uint32 maximum ${ATLAS_ASSET_ID_MAX}`
    )
  }

  return id
}

/** Formats an asset id in its canonical decimal form (`2`). */
export const formatAtlasAssetId = (id: bigint): string => {
  if (id < 0n || id > ATLAS_ASSET_ID_MAX) {
    throw new Error(
      `Invalid Atlas asset id ${id}: expected a value between 0 and ${ATLAS_ASSET_ID_MAX}`
    )
  }

  return id.toString()
}
