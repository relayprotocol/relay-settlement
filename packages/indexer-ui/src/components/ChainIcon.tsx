import { useState } from "react"
import { useTheme, type Theme } from "../theme"
import { cx } from "../utils"

const LOCAL_ICONS: Record<string, "png" | "svg"> = {
  "25": "png",
  "295": "svg",
  "360": "png",
  "988": "png",
  "1329": "png",
  "4326": "png",
  "4663": "png",
  "5042": "svg",
  "42018": "svg",
  "97477": "png",
  "1313161554": "svg",
}

const FALLBACK_IDS: Record<string, string> = {
  "Robinhood Lighter": "4663",
}

const iconUrl = (id: string, theme: Theme) =>
  LOCAL_ICONS[id]
    ? `/icons/chains/${id}/${theme}.${LOCAL_ICONS[id]}`
    : `https://assets.relay.link/icons/square/${id}/${theme}.png`

const SKELETON = "bg-element motion-safe:animate-pulse"

const ICONS = new Map<string, HTMLImageElement | null>()

const retain = (src: string) => {
  if (ICONS.has(src)) return
  const image = new Image()
  image.referrerPolicy = "no-referrer"
  image.src = src
  ICONS.set(src, image)
}

export function ChainIcon({
  id,
  name,
  className = "size-5",
  eager = false,
}: {
  id?: string | null
  name: string
  className?: string
  eager?: boolean
}) {
  const theme = useTheme()
  const relayTestnet = name === "Relay Testnet"
  const iconId = relayTestnet ? "537713" : (id ?? FALLBACK_IDS[name])
  const src = iconId ? iconUrl(iconId, theme) : undefined
  const [, setSettled] = useState<string>()
  const cached = src ? ICONS.get(src) : undefined
  const box = cx("shrink-0 rounded-full ring-1 ring-line-strong/60", className)
  if (!src || cached === null)
    return (
      <span
        aria-hidden
        className={cx(
          box,
          "grid place-items-center bg-element text-[10px] font-semibold text-fg-subtle uppercase",
          !name && SKELETON
        )}
      >
        {name.slice(0, 2)}
      </span>
    )
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      loading={eager ? "eager" : "lazy"}
      fetchPriority={eager ? "high" : "auto"}
      decoding="async"
      referrerPolicy="no-referrer"
      onLoad={() => {
        retain(src)
        setSettled(src)
      }}
      onError={() => {
        ICONS.set(src, null)
        setSettled(src)
      }}
      className={cx(
        box,
        "object-cover",
        relayTestnet && "grayscale",
        !cached && SKELETON
      )}
    />
  )
}
