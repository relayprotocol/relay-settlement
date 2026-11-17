import type { ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { priceQueries } from "../api/queries"
import type { PriceSourceDetails } from "../api/schema"
import { usdPrice } from "../depositoryValues"
import {
  belowUsdFloor,
  formatUsd,
  formatUsdPrice,
  USD_FLOOR,
  usdValue,
} from "../utils"
import { Tooltip } from "./Tooltip"
import { Muted } from "./ui"

const USD_TONES = {
  error: "text-error-fg",
  success: "text-success-fg",
}

type UsdTone = keyof typeof USD_TONES

export function UsdAmount({ value }: { value: number }) {
  if (!belowUsdFloor(value)) return formatUsd(value)
  return (
    <span className="whitespace-nowrap">
      <span className="mr-[0.25em] opacity-60">&lt;</span>
      {formatUsd(USD_FLOOR)}
    </span>
  )
}

export function Usd({
  value,
  price = false,
  tone = "success",
}: {
  value: number | string
  price?: boolean
  tone?: UsdTone
}) {
  return (
    <span className={USD_TONES[tone]}>
      {price ? formatUsdPrice(value) : <UsdAmount value={Number(value)} />}
    </span>
  )
}

const usePrice = (tokenId: string) => {
  const { data, error } = useQuery(priceQueries.price(tokenId))
  return {
    price: usdPrice(data),
    settled: data !== undefined || error != null,
    source: data?.price?.source,
  }
}

function Missing({ settled }: { settled: boolean }) {
  return <Muted>{settled ? "-" : "..."}</Muted>
}

export const PRICE_SOURCE_NAMES: Record<PriceSourceDetails["kind"], string> = {
  contract: "Price Oracle",
  relay: "Relay API",
}

const usePriceSourceHint = (source?: string) => {
  const kind = useQuery(priceQueries.sources()).data?.sources.find(
    (info) => info.id === source
  )?.kind
  return source
    ? `Price source: ${kind ? PRICE_SOURCE_NAMES[kind] : source}`
    : undefined
}

function Sourced({
  source,
  children,
}: {
  source?: string
  children: ReactNode
}) {
  return (
    <Tooltip content={usePriceSourceHint(source)}>
      <span>{children}</span>
    </Tooltip>
  )
}

export function SourcedPrice({
  value,
  source,
}: {
  value: number | string
  source?: string
}) {
  return (
    <Sourced source={source}>
      <Usd value={value} price />
    </Sourced>
  )
}

export function UsdPrice({ tokenId }: { tokenId: string }) {
  const { price, settled, source } = usePrice(tokenId)
  if (!price) return <Missing settled={settled} />
  return <SourcedPrice value={price} source={source} />
}

export function UsdValue({
  tokenId,
  amount,
  decimals,
  tone,
}: {
  tokenId: string
  amount: string
  decimals?: number | null
  tone?: UsdTone
}) {
  const { price, settled, source } = usePrice(tokenId)
  if (!price) return <Missing settled={settled} />
  return (
    <Sourced source={source}>
      <Usd value={usdValue(amount, decimals, price)} tone={tone} />
    </Sourced>
  )
}
