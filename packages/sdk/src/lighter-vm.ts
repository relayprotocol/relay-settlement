// ABOUTME: Canonical Lighter identity codec — account indices as decimal strings
// ABOUTME: and the range they must fit, shared by the lighter-vm cases in utils.ts.

// Account indices are `uint48` in the Lighter gateway (`changePubKey(uint48, ...)`),
// the tightest width any consumer holds.
export const LIGHTER_ACCOUNT_INDEX_MAX = (1n << 48n) - 1n

// Canonical form: decimal digits, no leading zeros, sign, whitespace or prefix
const LIGHTER_ACCOUNT_INDEX_REGEX = /^(0|[1-9][0-9]*)$/

/**
 * Parses a canonical Lighter account index (e.g. `508431`).
 *
 * Noncanonical spellings (exponent or decimal notation, signs, whitespace,
 * radix prefixes, leading zeros, values above the uint48 maximum) are
 * rejected rather than normalized, so an identity has exactly one spelling.
 */
export const parseLighterAccountIndex = (value: string): bigint => {
  if (!LIGHTER_ACCOUNT_INDEX_REGEX.test(value)) {
    throw new Error(
      `Invalid Lighter account index "${value}": expected a canonical decimal integer (e.g. 508431)`
    )
  }

  const accountIndex = BigInt(value)
  if (accountIndex > LIGHTER_ACCOUNT_INDEX_MAX) {
    throw new Error(
      `Invalid Lighter account index "${value}": exceeds the uint48 maximum ${LIGHTER_ACCOUNT_INDEX_MAX}`
    )
  }

  return accountIndex
}

/** Formats an account index in its canonical decimal form (`508431`). */
export const formatLighterAccountIndex = (accountIndex: bigint): string => {
  if (accountIndex < 0n || accountIndex > LIGHTER_ACCOUNT_INDEX_MAX) {
    throw new Error(
      `Invalid Lighter account index ${accountIndex}: expected a value between 0 and ${LIGHTER_ACCOUNT_INDEX_MAX}`
    )
  }

  return accountIndex.toString()
}
