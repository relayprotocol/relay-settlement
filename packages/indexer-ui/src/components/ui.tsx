import {
  Children,
  Fragment,
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react"
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Copy,
  Search,
} from "lucide-react"
import * as Popover from "@radix-ui/react-popover"
import { ConnectionError } from "../api/client"
import { useNow } from "../now"
import { Tooltip } from "./Tooltip"
import {
  cx,
  formatAmount,
  formatDateTime,
  formatDuration,
  formatNumber,
} from "../utils"

export function Muted({ children = "-" }: { children?: ReactNode }) {
  return <span className="text-fg-muted">{children}</span>
}

export function Amount({
  value,
  decimals,
  hint,
  places,
}: {
  value: string
  decimals?: number | null
  hint?: string
  places?: number
}) {
  const full = formatAmount(value, decimals, Infinity)
  return (
    <Tooltip
      content={
        hint ? (
          <span className="flex flex-col gap-0.5">
            {full}
            <span className="text-fg-muted">{hint}</span>
          </span>
        ) : (
          full
        )
      }
    >
      <span>{formatAmount(value, decimals, places)}</span>
    </Tooltip>
  )
}

const UNLIMITED = 2n ** 254n

export const isMaxLimit = (value: string) => BigInt(value) >= UNLIMITED

export function MaxLimit({ value }: { value?: string }) {
  return (
    <Tooltip content={value}>
      <span>max</span>
    </Tooltip>
  )
}

export function useCopy(value: string) {
  const [copied, setCopied] = useState(false)
  const copy = () =>
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  return { copied, copy }
}

export function CopyButton({
  value,
  className,
}: {
  value: string
  className?: string
}) {
  const { copied, copy } = useCopy(value)
  const Icon = copied ? Check : Copy
  return (
    <Tooltip content={copied ? "Copied" : "Copy"}>
      <button
        type="button"
        aria-label="Copy"
        onClick={() => copy()}
        className={cx(
          "grid h-5 w-3.5 shrink-0 cursor-pointer place-items-center rounded-sm text-fg-muted transition-colors outline-none group-hover/cell:opacity-100 group-hover/copy:opacity-100 hover:text-fg focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-primary-fg pointer-coarse:opacity-100",
          !copied && "opacity-0",
          className
        )}
      >
        <Icon
          aria-hidden
          className={cx("size-3", copied && "text-success-fg")}
        />
      </button>
    </Tooltip>
  )
}

export function CollapsedList({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener("scroll", close, { capture: true, passive: true })
    return () => window.removeEventListener("scroll", close, { capture: true })
  }, [open])
  const items = Children.toArray(children)
  if (!items.length) return <Muted />
  if (items.length === 1) return children
  const label = `Show ${items.length} items`
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip content={label}>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={label}
            className={cx(
              BADGE,
              BADGE_TONES.neutral,
              "group cursor-pointer gap-1 transition-colors outline-none hover:bg-element hover:text-fg focus-visible:ring-2 focus-visible:ring-primary-fg aria-expanded:bg-element aria-expanded:text-fg"
            )}
          >
            {items.length}
            <ChevronDown
              aria-hidden
              className="size-3 opacity-60 transition-transform group-aria-expanded:rotate-180"
            />
          </button>
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          tabIndex={-1}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            if (event.currentTarget instanceof HTMLElement)
              event.currentTarget.focus({ preventScroll: true })
          }}
          className="z-30 flex max-w-[calc(100vw-1rem)] flex-col items-start gap-1.5 rounded-md border border-line-strong bg-surface px-3 py-2 text-sm shadow-lg outline-none"
        >
          {items}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

export function Panel({
  title,
  hint,
  badge,
  actions,
  children,
}: {
  title: ReactNode
  hint?: string
  badge?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Tooltip content={hint}>
            <h2 className="text-sm font-semibold wrap-anywhere">{title}</h2>
          </Tooltip>
          {badge}
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </header>
      {children}
    </section>
  )
}

const COUNT_PILL =
  "rounded-full bg-element/70 px-2 py-0.5 text-xs text-(--slate-10) tabular-nums"

export function TitleCount({
  shown,
  total,
  filtered,
  label,
}: {
  shown: number
  total: number
  filtered: boolean
  label: string
}) {
  const totalText = `${formatNumber(total)} ${label}`
  const shownText = `${formatNumber(shown)} ${label} shown`
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {filtered ? (
        <>
          <span aria-label={shownText} className={COUNT_PILL}>
            {formatNumber(shown)}
          </span>
          <span aria-hidden className="text-xs text-fg-muted">
            of
          </span>
        </>
      ) : null}
      <span aria-label={totalText} className={COUNT_PILL}>
        {formatNumber(total)}
      </span>
    </span>
  )
}

export function Card({
  title,
  actions,
  children,
}: {
  title: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-md border border-line bg-surface">
      <header className="flex min-h-8 flex-wrap items-center justify-between gap-3 border-b border-line px-3 py-2">
        <h3 className="text-sm font-medium wrap-anywhere">{title}</h3>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </header>
      {children}
    </section>
  )
}

type SortValue = number | string | null | undefined

export type Column<T> = {
  header: ReactNode
  title: string
  cell: (row: T) => ReactNode
  align?: "right"
  fit?: boolean
  fill?: boolean
  sortValue?: (row: T) => SortValue
}

const cellPadding = (column: { fit?: boolean; fill?: boolean }) =>
  column.fit ? "w-px px-3" : cx("px-4", column.fill && "w-full")

const compare = (a: SortValue, b: SortValue, descending: boolean) => {
  if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1
  const order =
    typeof a === "number" && typeof b === "number"
      ? a - b
      : String(a).localeCompare(String(b))
  return descending ? -order : order
}

const observeScrollEdges = (element: HTMLDivElement | null) => {
  const viewport = element?.firstElementChild
  const content = viewport?.firstElementChild
  if (!element || !viewport || !content) return
  const update = () => {
    element.toggleAttribute("data-scroll-left", viewport.scrollLeft > 1)
    element.toggleAttribute(
      "data-scroll-right",
      viewport.scrollWidth - viewport.clientWidth - viewport.scrollLeft > 1
    )
  }
  update()
  const observer = new ResizeObserver(update)
  observer.observe(viewport)
  observer.observe(content)
  viewport.addEventListener("scroll", update, { passive: true })
  return () => {
    observer.disconnect()
    viewport.removeEventListener("scroll", update)
  }
}

function ScrollArea({ children }: { children: ReactNode }) {
  return (
    <div ref={observeScrollEdges} className="scroll-shadow-x">
      <div className="overflow-x-auto">{children}</div>
    </div>
  )
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  empty = "No data",
  defaultSort,
  page,
  pending = false,
  error,
}: {
  columns: Column<T>[]
  rows: T[] | undefined
  rowKey: (row: T) => string
  empty?: ReactNode
  defaultSort?: { column: number; descending: boolean }
  page?: { number: number; size: number; reset: () => void }
  pending?: boolean
  error?: Error | null
}) {
  const [sort, setSort] = useState(defaultSort)
  const sortValue = sort && columns[sort.column]?.sortValue
  const sorted =
    rows && sortValue
      ? rows.toSorted((a, b) =>
          compare(sortValue(a), sortValue(b), sort.descending)
        )
      : rows
  const visible =
    sorted && page
      ? sorted.slice((page.number - 1) * page.size, page.number * page.size)
      : sorted

  return (
    <ScrollArea>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line bg-subtle text-xs text-fg-subtle">
            {columns.map((column, index) => {
              const active = sort?.column === index
              const SortIcon = !active
                ? ChevronsUpDown
                : sort.descending
                  ? ArrowDown
                  : ArrowUp
              return (
                <th
                  key={index}
                  aria-sort={
                    active
                      ? sort.descending
                        ? "descending"
                        : "ascending"
                      : undefined
                  }
                  className={cx(
                    "py-2 font-medium whitespace-nowrap",
                    cellPadding(column),
                    column.align === "right" ? "text-right" : "text-left"
                  )}
                >
                  <Tooltip content={column.title}>
                    {column.sortValue ? (
                      <button
                        type="button"
                        onClick={() => {
                          setSort({
                            column: index,
                            descending: active
                              ? !sort.descending
                              : column.align === "right",
                          })
                          page?.reset()
                        }}
                        className={cx(
                          "-mx-1 inline-flex cursor-pointer items-center gap-1 rounded-sm px-1 hover:text-fg",
                          column.align === "right" && "flex-row-reverse",
                          active && "text-fg"
                        )}
                      >
                        {column.header}
                        <SortIcon
                          aria-hidden
                          className={cx("size-3", !active && "text-fg-muted")}
                        />
                      </button>
                    ) : (
                      <span>{column.header}</span>
                    )}
                  </Tooltip>
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody
          aria-busy={!rows || pending}
          className={cx("transition-opacity", pending && "opacity-60")}
        >
          {visible?.length ? (
            visible.map((row) => (
              <tr
                key={rowKey(row)}
                className="border-b border-line last:border-0 hover:bg-subtle"
              >
                {columns.map((column, index) => (
                  <td
                    key={index}
                    className={cx(
                      "group/cell py-2.5 whitespace-nowrap",
                      cellPadding(column),
                      column.align === "right" && "text-right tabular-nums"
                    )}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td
                colSpan={columns.length}
                className="px-4 py-10 text-center text-fg-muted"
              >
                {rows ? empty : <LoadState error={error} />}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </ScrollArea>
  )
}

type FactItem = { label: string; value: ReactNode; hint?: ReactNode }

const FACT_SIZES = {
  md: {
    grid: "grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]",
    cell: "gap-1.5",
    label: "text-sm",
    value: "font-mono text-sm wrap-anywhere",
  },
  lg: {
    grid: "grid-cols-[repeat(auto-fit,minmax(8rem,1fr))]",
    cell: "gap-1",
    label: "text-xs",
    value: "text-lg font-semibold break-words tabular-nums",
  },
}

const breakAfterUnderscores = (label: string) =>
  label.split(/(?<=_)/).map((part, index) => (
    <Fragment key={index}>
      {index ? <wbr /> : null}
      {part}
    </Fragment>
  ))

export function FactGrid({
  items,
  size = "md",
}: {
  items: FactItem[]
  size?: keyof typeof FACT_SIZES
}) {
  const detail = size === "md"
  return (
    <dl className={cx("-mr-px -mb-px grid", FACT_SIZES[size].grid)}>
      {items.map((item) => (
        <div
          key={item.label}
          className={cx(
            "flex min-w-0 flex-col border-r border-b border-line px-4 py-3",
            FACT_SIZES[size].cell
          )}
        >
          <Tooltip content={detail ? item.hint : undefined}>
            <dt
              className={cx(
                "self-start text-fg-subtle wrap-anywhere",
                FACT_SIZES[size].label
              )}
            >
              {breakAfterUnderscores(item.label)}
            </dt>
          </Tooltip>
          <dd className={FACT_SIZES[size].value}>{item.value}</dd>
          {!detail && item.hint ? (
            <dd className="text-xs text-fg-muted">{item.hint}</dd>
          ) : null}
        </div>
      ))}
    </dl>
  )
}

export function KeyValuePanel({
  title = "Configuration",
  items,
  empty = "No configuration",
  error,
}: {
  title?: ReactNode
  items?: Array<Omit<FactItem, "value"> & { value?: ReactNode }>
  empty?: ReactNode
  error?: Error | null
}) {
  const visible = items?.filter((item): item is FactItem => item.value != null)
  return (
    <Panel title={title}>
      {visible?.length ? (
        <FactGrid items={visible} />
      ) : (
        <EmptyState>{visible ? empty : <LoadState error={error} />}</EmptyState>
      )}
    </Panel>
  )
}

export function RelativeTime({
  value,
  hint,
  tooltip,
}: {
  value?: string | null
  hint?: string
  tooltip?: (_now: number) => ReactNode
}) {
  const now = useNow()
  if (!value)
    return (
      <Tooltip content={tooltip?.(now) ?? hint}>
        <span>
          <Muted />
        </span>
      </Tooltip>
    )
  const delta = Date.parse(value) - now
  return (
    <Tooltip
      content={
        tooltip?.(now) ??
        (hint ? (
          <span className="flex flex-col gap-0.5">
            {formatDateTime(value)}
            <span className="text-fg-muted">{hint}</span>
          </span>
        ) : (
          formatDateTime(value)
        ))
      }
    >
      <time dateTime={value}>
        {delta >= 1000
          ? `in ${formatDuration(delta)}`
          : delta <= -1000
            ? `${formatDuration(delta)} ago`
            : "now"}
      </time>
    </Tooltip>
  )
}

const BADGE =
  "inline-flex items-center rounded-sm border px-1.5 py-0.5 font-sans text-xs font-medium whitespace-nowrap"

const BADGE_TONES = {
  error: "border-error-bg/90 bg-error-bg/70 text-error-fg",
  muted: "border-subtle/90 bg-subtle/70 text-fg-muted",
  neutral: "border-element/90 bg-element/70 text-fg-subtle",
  primary: "border-primary-bg/90 bg-primary-bg/70 text-primary-on-bg",
  success: "border-success-bg/90 bg-success-bg/70 text-success-fg",
  warning: "border-warning-bg/90 bg-warning-bg/70 text-warning-fg",
}

type BadgeTone = keyof typeof BADGE_TONES

export function Badge({
  tone = "neutral",
  title,
  children,
}: {
  tone?: BadgeTone
  title?: ReactNode
  children: ReactNode
}) {
  return (
    <Tooltip content={title}>
      <span className={cx(BADGE, BADGE_TONES[tone])}>{children}</span>
    </Tooltip>
  )
}

export function LoadState({ error }: { error?: Error | null }) {
  if (!error) return "Loading..."
  return error instanceof ConnectionError ? (
    <Tooltip content={error.message}>
      <span>No cached data</span>
    </Tooltip>
  ) : (
    <Tooltip content={error.message}>
      <span className="text-error-fg">Failed to load</span>
    </Tooltip>
  )
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 py-10 text-center text-sm text-fg-muted">
      {children}
    </div>
  )
}

const BUTTON =
  "inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"

const BUTTON_VARIANTS = {
  neutral:
    "bg-element text-fg-subtle hover:bg-element-hover hover:text-fg active:bg-element-active",
  primary: "bg-primary text-white hover:bg-primary-hover",
  secondary: "border border-line bg-surface hover:border-line-strong",
  soft: "bg-primary-bg text-primary-on-bg hover:text-primary-strong",
}

export function Button({
  variant = "secondary",
  icon = false,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof BUTTON_VARIANTS
  icon?: boolean
}) {
  return (
    <button
      type="button"
      className={cx(
        BUTTON,
        icon ? "w-8" : "px-3",
        BUTTON_VARIANTS[variant],
        className
      )}
      {...props}
    />
  )
}

export function IconButton({
  label,
  pressed,
  small = false,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  pressed?: boolean
  small?: boolean
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        className={cx(
          "grid shrink-0 cursor-pointer place-items-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-50",
          small ? "size-8" : "size-9",
          pressed
            ? "border-primary-line bg-primary-bg/80 text-primary-on-bg hover:text-primary-strong"
            : "border-line bg-surface text-fg-subtle hover:bg-element hover:text-fg active:bg-element-hover",
          className
        )}
        {...props}
      />
    </Tooltip>
  )
}

export const FIELD =
  "h-8 rounded-md border border-line bg-surface px-2.5 text-sm transition-colors outline-none placeholder:text-fg-muted hover:border-line-strong focus:border-primary-fg aria-invalid:border-error-line"

export function TextInput({
  invalid,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input aria-invalid={invalid} className={cx(FIELD, className)} {...props} />
  )
}

export function SearchInput({
  invalid,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <label className="relative inline-grid min-w-36">
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-muted"
      />
      <span
        aria-hidden
        className="invisible col-start-1 row-start-1 border-x pr-4 pl-8 text-sm whitespace-pre"
      >
        {props.placeholder}
      </span>
      <input
        type="search"
        aria-label={props.placeholder}
        aria-invalid={invalid}
        spellCheck={false}
        autoComplete="off"
        className={cx(
          FIELD,
          "col-start-1 row-start-1 w-0 min-w-full pr-2 pl-8 [&::-webkit-search-cancel-button]:appearance-none",
          className
        )}
        {...props}
      />
    </label>
  )
}

export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: Array<{ label: string; value: T }>
  value: T
  onChange: (_value: T) => void
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex max-w-full flex-wrap rounded-md bg-element p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cx(
            "cursor-pointer rounded-[6px] px-2.5 py-1 text-xs font-medium transition-colors",
            option.value === value
              ? "bg-surface text-fg shadow-sm dark:bg-element-active"
              : "text-fg-subtle hover:text-fg"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Pager({
  page,
  pages,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
}: {
  page: number
  pages?: number
  hasPrevious: boolean
  hasNext: boolean
  onPrevious: () => void
  onNext: () => void
}) {
  return (
    <div className="flex items-center gap-1">
      <Button
        aria-label="Previous page"
        icon
        disabled={!hasPrevious}
        onClick={onPrevious}
      >
        <ChevronLeft aria-hidden className="size-4" />
      </Button>
      <span
        aria-live="polite"
        className="px-2 text-xs text-fg-subtle tabular-nums"
      >
        Page {page}
        {pages == null ? null : ` of ${Math.max(pages, page)}`}
      </span>
      <Button aria-label="Next page" icon disabled={!hasNext} onClick={onNext}>
        <ChevronRight aria-hidden className="size-4" />
      </Button>
    </div>
  )
}
