"use client"

/**
 * Chain and token icon components matching relay-kit style.
 *
 * Chain icons: https://assets.relay.link/icons/square/{chainId}/light.png
 * Token logos: from solver API currency.metadata.logoURI
 */

interface ChainIconProps {
  chainId?: number
  iconUrl?: string | null
  size?: number
  className?: string
}

export function ChainIcon({
  chainId,
  iconUrl,
  size = 20,
  className = "",
}: ChainIconProps) {
  // Use relay-link CDN if no iconUrl provided
  const src =
    iconUrl ||
    (chainId
      ? `https://assets.relay.link/icons/square/${chainId}/light.png`
      : null)

  if (!src) return null

  return (
    <img
      src={src}
      alt={chainId ? `Chain ${chainId}` : ""}
      width={size}
      height={size}
      className={`rounded ${className}`}
      style={{ borderRadius: 4 }}
    />
  )
}

interface TokenIconProps {
  logoURI?: string | null
  symbol?: string
  size?: number
  className?: string
}

export function TokenIcon({
  logoURI,
  symbol,
  size = 20,
  className = "",
}: TokenIconProps) {
  if (logoURI && logoURI !== "missing.png") {
    return (
      <img
        src={logoURI}
        alt={symbol ?? "Token"}
        width={size}
        height={size}
        className={`rounded-full ${className}`}
      />
    )
  }

  // Fallback: first letter of symbol
  if (symbol) {
    return (
      <div
        className={`rounded-full bg-primary-3 text-primary-8 flex items-center justify-center text-xs font-bold ${className}`}
        style={{ width: size, height: size }}
      >
        {symbol.charAt(0).toUpperCase()}
      </div>
    )
  }

  return null
}

interface ChainTokenIconProps {
  chainId?: number
  chainIconUrl?: string | null
  tokenLogoURI?: string | null
  tokenSymbol?: string
  size?: "sm" | "md" | "lg"
  className?: string
}

const SIZES = {
  sm: { token: 20, chain: 10 },
  md: { token: 32, chain: 14 },
  lg: { token: 40, chain: 18 },
}

export function ChainTokenIconCombo({
  chainId,
  chainIconUrl,
  tokenLogoURI,
  tokenSymbol,
  size = "md",
  className = "",
}: ChainTokenIconProps) {
  const dim = SIZES[size]

  return (
    <div
      className={`relative shrink-0 ${className}`}
      style={{ width: dim.token, height: dim.token }}
    >
      <TokenIcon logoURI={tokenLogoURI} symbol={tokenSymbol} size={dim.token} />
      <div
        className="absolute right-0 bottom-0 overflow-hidden border border-white bg-white"
        style={{ borderRadius: 3 }}
      >
        <ChainIcon chainId={chainId} iconUrl={chainIconUrl} size={dim.chain} />
      </div>
    </div>
  )
}
