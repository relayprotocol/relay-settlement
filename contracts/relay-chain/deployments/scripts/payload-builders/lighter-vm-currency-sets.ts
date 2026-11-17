/**
 * Per-deployment instance and currency metadata read by `LighterVmPayloadBuilder`.
 *
 * Each Lighter deployment (Lighter mainnet, Robinhood Lighter) is its own
 * Relay chain id served by the one generic `lighter-vm` payload builder. The
 * Config store keys are derived from the chain id, so every deployment carries
 * its own `LIGHTER_VM_FROM_ACCOUNT_INDEX` (the depository account index) and
 * `LIGHTER_VM_CHAIN_ID` (the Lighter app-chain id below), plus its own set of
 * `LIGHTER_VM_FROM_ROUTE_TYPE`, `LIGHTER_VM_TO_ROUTE_TYPE` and
 * `LIGHTER_VM_ASSET_INDEX` values, seeded from the currency sets below.
 *
 * Route type 0 is the perpetuals (collateral) account, route type 1 is spot.
 * The all-zero currency is the SDK's `lighter-vm` native-currency sentinel and
 * denotes the deployment's collateral asset.
 */

import type { Hex } from "viem"

export type LighterCurrencyConfig = {
  currency: Hex
  label: string
  routeType: bigint
  assetIndex: bigint
}

export const LIGHTER_VM_NATIVE_CURRENCY: Hex = `0x${"00".repeat(16)}`

/** Lighter mainnet (L1 Ethereum, app-chain id 304), Relay chain id `lighter`. */
export const LIGHTER_MAINNET_CURRENCIES: LighterCurrencyConfig[] = [
  {
    assetIndex: 3n,
    currency: LIGHTER_VM_NATIVE_CURRENCY,
    label: "USDC Perp",
    routeType: 0n,
  },
  {
    assetIndex: 1n,
    currency: "0x00000000000000000000000000000001",
    label: "ETH Spot",
    routeType: 1n,
  },
  {
    assetIndex: 3n,
    currency: "0x00000000000000000000000000000003",
    label: "USDC Spot",
    routeType: 1n,
  },
]

/**
 * Robinhood Lighter (L1 Robinhood Chain 4663, app-chain id 466324), Relay
 * chain id `robinhood-lighter`. USDG is the collateral asset; account reads
 * on `api.rh.lighter.xyz` report it as `asset_id` 3 in the perpetuals account.
 * No spot routes are configured.
 */
export const ROBINHOOD_LIGHTER_CURRENCIES: LighterCurrencyConfig[] = [
  {
    assetIndex: 3n,
    currency: LIGHTER_VM_NATIVE_CURRENCY,
    label: "USDG Perp",
    routeType: 0n,
  },
]

/** Currency set keyed by Relay chain id. */
export const LIGHTER_VM_CURRENCY_SETS: Record<string, LighterCurrencyConfig[]> =
  {
    lighter: LIGHTER_MAINNET_CURRENCIES,
    "robinhood-lighter": ROBINHOOD_LIGHTER_CURRENCIES,
  }

export function getLighterCurrencySet(
  chainId: string
): LighterCurrencyConfig[] {
  const set = LIGHTER_VM_CURRENCY_SETS[chainId]
  if (!set) {
    throw new Error(
      `No Lighter currency set for chain id "${chainId}" (known: ${Object.keys(
        LIGHTER_VM_CURRENCY_SETS
      ).join(", ")})`
    )
  }
  return set
}

/**
 * Lighter app-chain id signed into each deployment's transfer L1 message,
 * keyed by Relay chain id.
 */
export const LIGHTER_VM_APP_CHAIN_IDS: Record<string, bigint> = {
  lighter: 304n,
  "robinhood-lighter": 466324n,
}

export function getLighterAppChainId(chainId: string): bigint {
  const appChainId = LIGHTER_VM_APP_CHAIN_IDS[chainId]
  if (appChainId === undefined) {
    throw new Error(
      `No Lighter app-chain id for chain id "${chainId}" (known: ${Object.keys(
        LIGHTER_VM_APP_CHAIN_IDS
      ).join(", ")})`
    )
  }
  return appChainId
}
