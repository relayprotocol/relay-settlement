const TOKEN_NAME_MAX = 50
export const RELAY_SOLVER_ADDRESS = "0xd5fa4f5834722d85d95f45387ed60ce09ba4e36f"

export const cx = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(" ")

export const formatNumber = (value: number) => value.toLocaleString("en-US")

export const plural = (count: number, noun: string) =>
  `${formatNumber(count)} ${noun}${count === 1 ? "" : "s"}`

const COMPACT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  notation: "compact",
})

export const formatCompact = (value: number) => COMPACT.format(value)

const USD = new Intl.NumberFormat("en-US", {
  currency: "USD",
  style: "currency",
})

const USD_PRECISE = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumSignificantDigits: 6,
  style: "currency",
})

export const USD_FLOOR = 0.01

export const belowUsdFloor = (value: number) => value > 0 && value < USD_FLOOR

export const formatUsd = (value: number) =>
  belowUsdFloor(value) ? `< ${USD.format(USD_FLOOR)}` : USD.format(value)

export const formatUsdPrice = (value: number | string) => {
  const price = Number(value)
  return Number(price.toPrecision(6)) >= 1
    ? USD.format(price)
    : USD_PRECISE.format(price)
}

export const usdValue = (
  amount: string,
  decimals: number | null | undefined,
  price: string
) => (Number(amount) / 10 ** (decimals ?? 0)) * Number(price)

const COMPACT_FRACTION = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
})

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"]

export const formatBytes = (bytes: number) => {
  const exponent =
    bytes < 1
      ? 0
      : Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log2(bytes) / 10))
  return `${COMPACT_FRACTION.format(bytes / 1024 ** exponent)} ${BYTE_UNITS[exponent]}`
}

export const formatDuration = (ms: number) => {
  const seconds = Math.round(Math.abs(ms) / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} m`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`
}

export const unixTime = (seconds?: string | null) =>
  seconds ? new Date(Number(seconds) * 1000).toISOString() : undefined

export const formatDeviation = (value: number) => {
  const percent = Number((value * 100).toFixed(2)) || 0
  return `${percent > 0 ? "+" : ""}${percent.toFixed(2)}%`
}

export const formatDateTime = (value: string) =>
  new Date(value)
    .toLocaleString("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
    .replace(",", "")

const MAX_WHOLE_DIGITS = 15

const scientific = (whole: bigint) => {
  const digits = (whole < 0n ? -whole : whole).toString()
  return digits.length > MAX_WHOLE_DIGITS
    ? `${whole < 0n ? "-" : ""}${digits[0]}.${digits.slice(1, 3)}e${digits.length - 1}`
    : undefined
}

const formatFixedPoint = (
  value: string,
  decimals?: number | null,
  maxFractionDigits?: number
) => {
  try {
    const amount = BigInt(value)
    if (decimals == null) return amount.toString()
    const places = Number(decimals)
    const scaled = Number.isFinite(places) && places > 0
    const divisor = scaled ? 10n ** BigInt(places) : 1n
    const whole = amount / divisor
    const short = Number.isFinite(maxFractionDigits)
      ? scientific(whole)
      : undefined
    if (short) return short
    if (!scaled) return amount.toLocaleString("en-US")
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

export const formatAmount = (
  value: string,
  decimals?: number | null,
  places = 6
) => formatFixedPoint(value, decimals, places)

export const formatPercent = (ratio: number) => `${(ratio * 100).toFixed(2)}%`

export const formatShare = (part: string, total: string) => {
  const whole = BigInt(total)
  return whole > 0n
    ? formatPercent(
        Math.min(1, Number((BigInt(part) * 10_000n) / whole) / 10_000)
      )
    : "-"
}

export const capitalize = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1)

export const formatChainName = (name: string) =>
  name.replace(/(?<=^|\s)\p{Ll}+(?=\s|$)/gu, capitalize)

export const shortHash = (value: string) =>
  value.length > 16 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value

export const shortTokenId = (value: string) =>
  value.length > 12 ? `${value.slice(0, 4)}...${value.slice(-4)}` : value

const shortTokenName = (value: string) => {
  if (value.length <= TOKEN_NAME_MAX) return value
  return `${value.slice(0, 4)}...${value.slice(-15)}`
}

const displayTokenName = (value?: string | null) => {
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

export const shortAddress = (address: string) =>
  address.length > 12
    ? `${address.slice(0, 6)}...${address.slice(-4)}`
    : address

export const tokenPath = (tokenId: string) => `/hub/tokens/${tokenId}`
const URL_PREFIX = /^[a-z][a-z\d+.-]*:\/\/[^/]/i

export const trimUrl = (value: string) =>
  URL_PREFIX.test(value) ? value.replace(/\/+$/, "") : value
export const walletPath = (address: string) => `/hub/wallets/${address}`
