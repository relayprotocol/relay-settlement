import { createContext, use, type ReactNode } from "react"
import { Link } from "react-router"
import { ArrowUpRight, Check, Copy } from "lucide-react"
import { explorerHost, explorerUrl, HUB_CHAIN } from "../explorers"
import { useLabels } from "../labels"
import { usePrefetchOnIntent } from "../prefetch"
import { poolPath, type Pool } from "../pools"
import { useTokens } from "../tokens"
import {
  cx,
  displayTokenLabel,
  shortAddress,
  shortHash,
  tokenPath,
  walletPath,
} from "../utils"
import { prefetchWallet, useEmptyWallet } from "../wallets"
import { ChainIcon } from "./ChainIcon"
import { LinkTooltip, Tooltip } from "./Tooltip"
import { Badge, CopyButton, Muted, useCopy } from "./ui"

const LINK = "text-link hover:underline"

const OVERLAY = {
  always: {
    button: "absolute left-[calc(100%+var(--copy-gap)/2)] -translate-x-1/2",
    wrapper:
      "relative mr-[calc(var(--copy-gap)-var(--flow-gap,var(--copy-gap)))]",
  },
  md: {
    button:
      "md:absolute md:left-[calc(100%+var(--copy-gap)/2)] md:-translate-x-1/2",
    wrapper:
      "md:relative md:mr-[calc(var(--copy-gap)-var(--flow-gap,var(--copy-gap)))]",
  },
}

export const CopyOverlay = createContext<keyof typeof OVERLAY | undefined>(
  undefined
)

function Copyable({ value, children }: { value: string; children: ReactNode }) {
  const mode = use(CopyOverlay)
  const overlay = mode && OVERLAY[mode]
  return (
    <span
      className={cx(
        "group/copy inline-flex max-w-full items-center gap-1",
        overlay?.wrapper
      )}
    >
      {children}
      <CopyButton value={value} className={overlay?.button} />
    </span>
  )
}

function ExplorerLink({
  href,
  value,
  className,
  children,
}: {
  href: string
  value: string
  className?: string
  children: ReactNode
}) {
  return (
    <Tooltip content={<LinkTooltip value={value} host={explorerHost(href)} />}>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={cx(LINK, className)}
      >
        {children}
      </a>
    </Tooltip>
  )
}

export function AddressLink({
  address,
  full,
  className,
}: {
  address: string
  full?: boolean
  className?: string
}) {
  const label = useLabels().address(address)
  const prefetchProps = usePrefetchOnIntent()
  const href = useEmptyWallet(address)
    ? explorerUrl(HUB_CHAIN, "address", address)
    : undefined
  const text = (full ? address : label) ?? shortAddress(address)
  const style = cx((full || !label) && "font-mono", className)
  return (
    <Copyable value={address}>
      <Tooltip
        content={
          <LinkTooltip
            value={address}
            host={href ? explorerHost(href) : undefined}
          />
        }
      >
        <Link
          to={href ?? walletPath(address)}
          target={href ? "_blank" : undefined}
          rel={href ? "noreferrer" : undefined}
          className={cx(LINK, style)}
          {...(href ? {} : prefetchProps(prefetchWallet(address)))}
        >
          {text}
        </Link>
      </Tooltip>
    </Copyable>
  )
}

export function LabeledAddress({ address }: { address: string }) {
  const label = useLabels().address(address)
  return (
    <CopyOverlay value="always">
      <span className="inline-flex flex-wrap items-center gap-x-(--flow-gap) gap-y-0.5 [--flow-gap:--spacing(2)] max-md:hidden">
        <AddressLink full address={address} className="wrap-anywhere" />
        {label ? <Badge>{label}</Badge> : null}
      </span>
      <span className="[--flow-gap:--spacing(2)] md:hidden">
        <AddressLink address={address} />
      </span>
    </CopyOverlay>
  )
}

export function ChainLink({
  chain,
  depository,
  gateway,
}: {
  chain: string
  depository?: string | null
  gateway?: boolean
}) {
  const labels = useLabels()
  const name = labels.chain(chain)
  const badge = gateway ?? labels.gateway(chain, depository)
  const to = labels.chainPath(chain, badge)
  const id = labels.networkId(chain)
  const content = (
    <>
      <ChainIcon id={id} name={name} className="size-[1.25em]" />
      {name}
    </>
  )
  return (
    <span className="inline-flex items-center gap-2">
      <Tooltip content={id ? `Chain ID ${id}` : chain}>
        {to ? (
          <Link
            to={to}
            className={cx(LINK, "inline-flex items-center gap-1.5")}
          >
            {content}
          </Link>
        ) : (
          <span className="inline-flex items-center gap-1.5">{content}</span>
        )}
      </Tooltip>
      {badge ? <Badge>Gateway</Badge> : null}
    </span>
  )
}

export function OriginChain({
  id,
  vmType,
}: {
  id?: string | null
  vmType?: string | null
}) {
  const labels = useLabels()
  const origin = labels.origin(id)
  if (!origin) return labels.originChain(id)
  return <ChainLink chain={origin.chain} gateway={vmType === "gateway-vm"} />
}

export function HashText({
  value,
  short = shortHash,
}: {
  value: string
  short?: (value: string) => string
}) {
  return (
    <Copyable value={value}>
      <Tooltip content={value}>
        <span className="font-mono text-fg/85">{short(value)}</span>
      </Tooltip>
    </Copyable>
  )
}

export function TxLink({
  hash,
  chain = HUB_CHAIN,
}: {
  hash?: string | null
  chain?: string
}) {
  if (!hash) return <Muted />
  const href = explorerUrl(chain, "tx", hash)
  if (!href) return <HashText value={hash} />
  return (
    <Copyable value={hash}>
      <ExplorerLink href={href} value={hash} className="font-mono">
        {shortHash(hash)}
      </ExplorerLink>
    </Copyable>
  )
}

export function AccountLink({
  address,
  chain,
  full,
}: {
  address?: string | null
  chain: string
  full?: boolean
}) {
  if (!address) return <Muted />
  const href = explorerUrl(chain, "address", address)
  const text = full ? address : shortAddress(address)
  return (
    <Copyable value={address}>
      {href ? (
        <ExplorerLink
          href={href}
          value={address}
          className="font-mono wrap-anywhere"
        >
          {text}
        </ExplorerLink>
      ) : (
        <Tooltip content={address}>
          <span className="font-mono text-fg/85 wrap-anywhere">{text}</span>
        </Tooltip>
      )}
    </Copyable>
  )
}

export function OriginChainIcon({ id }: { id?: string | null }) {
  const labels = useLabels()
  if (!id) return null
  const name = labels.originChain(id)
  return (
    <Tooltip content={name}>
      <span className="inline-flex shrink-0">
        <ChainIcon
          id={labels.originNetworkId(id)}
          name={name}
          className="size-[1.25em]"
        />
      </span>
    </Tooltip>
  )
}

export function TokenLink({
  tokenId,
  name,
  symbol,
}: {
  tokenId: string
  name?: string | null
  symbol?: string | null
}) {
  const token = useTokens()?.get(tokenId)
  return (
    <span className="inline-flex max-w-full items-center gap-1.5">
      <OriginChainIcon id={token?.origin_chain_id} />
      <Tooltip content={<LinkTooltip value={token?.origin_asset ?? tokenId} />}>
        <Link to={tokenPath(tokenId)} className={cx(LINK, "truncate")}>
          {displayTokenLabel(name ?? token?.name, symbol ?? token?.symbol)}
        </Link>
      </Tooltip>
    </span>
  )
}

export function HubTokenLink({ tokenId }: { tokenId: string }) {
  const tokens = useTokens()
  if (!tokens) return <Muted>...</Muted>
  return <TokenLink tokenId={tokenId} />
}

const ADDRESS_ACTION =
  "grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm text-fg-muted transition-colors outline-none hover:bg-element-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-primary-fg"

export function ContractAddress({
  chain,
  address,
  label,
}: {
  chain: string
  address: string
  label: string
}) {
  const { copied, copy } = useCopy(address)
  const Icon = copied ? Check : Copy
  const href = explorerUrl(chain, "address", address)
  return (
    <span className="col-span-2 inline-flex max-w-full items-center gap-2 justify-self-start rounded-md border border-element/90 bg-element/70 py-1 pr-1 pl-2.5 sm:col-span-1 sm:col-start-2 sm:self-start">
      <Tooltip content={label}>
        <span className="min-w-0 font-mono text-sm wrap-anywhere">
          {address}
        </span>
      </Tooltip>
      <span className="flex shrink-0">
        <Tooltip content="Copy address">
          <button
            type="button"
            aria-label={`Copy ${label.toLowerCase()} address`}
            onClick={() => copy()}
            className={ADDRESS_ACTION}
          >
            <Icon
              aria-hidden
              className={cx("size-3.5", copied && "text-success-fg")}
            />
          </button>
        </Tooltip>
        {href ? (
          <Tooltip content={`Open in ${explorerHost(href)}`}>
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open ${label.toLowerCase()} in explorer`}
              className={ADDRESS_ACTION}
            >
              <ArrowUpRight aria-hidden className="size-3.5" />
            </a>
          </Tooltip>
        ) : null}
      </span>
    </span>
  )
}

export function PoolLink({ pool }: { pool: Pool }) {
  return (
    <Tooltip content={<LinkTooltip value={pool.address} />}>
      <Link to={poolPath(pool.address)} className={LINK}>
        {pool.name}
      </Link>
    </Tooltip>
  )
}

export const useErc20ViewTokenIds = () =>
  new Map(
    [...(useTokens()?.values() ?? [])].flatMap((token) =>
      token.erc20_view ? [[token.erc20_view.toLowerCase(), token.token_id]] : []
    )
  )

export function LockboxToken({
  token,
  symbol,
  tokenIds,
}: {
  token: string
  symbol: string
  tokenIds: Map<string, string>
}) {
  const tokenId = tokenIds.get(token.toLowerCase())
  return tokenId ? (
    <TokenLink tokenId={tokenId} />
  ) : (
    <span className="inline-flex items-center gap-1.5">
      <span>{symbol}</span>
      <AddressLink address={token} />
    </span>
  )
}
