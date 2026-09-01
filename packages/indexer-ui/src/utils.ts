import type { TokenPrice } from "./api"

export const TOKEN_NAME_MAX = 50
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
export const RELAY_SOLVER_ADDRESS = "0xd5fa4f5834722d85d95f45387ed60ce09ba4e36f"
export const EXPLORER_BASE = "https://explorer.chain.relay.link"

const formatFixedPoint = (
  value: string,
  decimals?: number | null,
  maxFractionDigits?: number
) => {
  try {
    const amount = BigInt(value)
    const places = decimals == null ? 0 : Number(decimals)
    if (!Number.isFinite(places) || places <= 0) {
      return amount.toLocaleString("en-US")
    }
    const divisor = 10n ** BigInt(places)
    const whole = amount / divisor
    const visiblePlaces =
      maxFractionDigits == null || !Number.isFinite(maxFractionDigits)
        ? places
        : Math.max(0, Math.min(places, Math.trunc(maxFractionDigits)))
    const fraction = (amount % divisor)
      .toString()
      .padStart(places, "0")
      .slice(0, visiblePlaces)
    const trimmed = fraction.replace(/0+$/, "")
    return trimmed
      ? `${whole.toLocaleString("en-US")}.${trimmed}`
      : whole.toLocaleString("en-US")
  } catch {
    return value
  }
}

export const formatAmount = (value: string, decimals?: number | null) =>
  formatFixedPoint(value, decimals)

export const formatUsdPrice = (
  value?: string | null,
  decimals?: number | null
) => (value == null ? "-" : `$${formatFixedPoint(value, decimals, 6)}`)

export const displayTokenUsdPrice = (
  price?: TokenPrice | null,
  fallback = "-"
) => {
  if (!price) return fallback
  if (price.status === "available") {
    return formatUsdPrice(price.usdPrice, price.usdPriceDecimals)
  }
  if (price.routeConfigured === false) return "Not configured"
  if (price.routeConfigured == null) return "Unknown"
  if (price.adapterConfigured === false) return "Missing adapter"
  if (price.adapterConfigured == null) return "Unknown"
  if (price.status === "unavailable") return "Unavailable"
  return "Unknown"
}

export const shortHash = (value: string) =>
  value.length > 16 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value

export const shortTokenId = (value: string) =>
  value.length > 10 ? `${value.slice(0, 4)}...${value.slice(-4)}` : value

export const shortTokenName = (value: string) => {
  if (value.length <= TOKEN_NAME_MAX) return value
  return `${value.slice(0, 4)}...${value.slice(-15)}`
}

export const displayTokenName = (value?: string | null) => {
  const trimmed = value?.trim()
  if (!trimmed) return "Unknown"
  return shortTokenName(trimmed)
}

export const displayTokenLabel = (
  name?: string | null,
  symbol?: string | null
) => {
  const trimmedSymbol = symbol?.trim()
  if (trimmedSymbol) return shortTokenName(trimmedSymbol)
  return displayTokenName(name)
}

export const txUrl = (hash: string) => `${EXPLORER_BASE}/tx/${hash}`
export const addressUrl = (address: string) =>
  `${EXPLORER_BASE}/address/${address}`
export const shortAddress = (address: string) =>
  address.length > 12
    ? `${address.slice(0, 6)}...${address.slice(-4)}`
    : address

export const displayAddress = (address: string) => {
  if (!address) return address
  if (address.toLowerCase() === RELAY_SOLVER_ADDRESS) {
    return "Relay Solver"
  }
  return shortAddress(address)
}

export const formatTimestamp = (unixSeconds: number) =>
  new Date(unixSeconds * 1000).toLocaleString("en-US", {
    hour12: false,
  })

export const tokenPath = (tokenId: string) =>
  `/token/${encodeURIComponent(tokenId)}`

export const tokenExplorerUrl = (tokenId: string) =>
  `${EXPLORER_BASE}/token/${encodeURIComponent(tokenId)}`

const ROLE_LABELS: Record<string, string> = {
  "0x97667070c54ef182b0f5858b034beac1b6f3089aa2d3188bb1e8929f4fa9b929":
    "Operator",
  "0x21d1167972f621f75904fb065136bc8b53c7ba1c60ccd3a7758fbee465851e9c":
    "Editor",
  "0xa49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775": "Admin",
}

export const displayRole = (role: string) =>
  ROLE_LABELS[role.toLowerCase()] ?? shortHash(role)
