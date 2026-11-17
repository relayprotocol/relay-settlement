import { useRef, useState, type ReactNode } from "react"
import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { ChevronsUpDown, Search, X } from "lucide-react"
import type { VmType } from "../api/schema"
import { vmLabel, vmOrder } from "../origins"
import { cx, formatChainName } from "../utils"
import { ChainIcon } from "./ChainIcon"
import { Tooltip } from "./Tooltip"
import { FIELD } from "./ui"

export type PickerOption<T extends string = string> = {
  id: T
  name: string
  group?: string
  hint?: string
  icon?: ReactNode
  trailing?: ReactNode
}

export const chainOptions = <T extends string>(
  chains: Array<{
    chain: T
    name: string
    network_id?: string | null
    vm_type: VmType
  }>
): PickerOption<T>[] =>
  chains
    .map((chain) => ({ ...chain, label: formatChainName(chain.name) }))
    .toSorted(
      (a, b) =>
        vmOrder(a.vm_type) - vmOrder(b.vm_type) ||
        a.label.localeCompare(b.label)
    )
    .map((chain) => ({
      group: vmLabel(chain.vm_type),
      icon: <ChainIcon id={chain.network_id} name={chain.label} />,
      id: chain.chain,
      name: chain.label,
    }))

const TRIGGERS = {
  field: cx(
    FIELD,
    "inline-flex min-w-0 cursor-pointer items-center gap-2 pr-2 text-left data-[state=open]:border-primary-fg"
  ),
  title:
    "inline-flex cursor-pointer items-center gap-2.5 self-start rounded-md py-1.5 pr-3 pl-4 text-lg leading-tight font-semibold border border-element transition-colors outline-none hover:border-element-hover hover:bg-element/70 focus-visible:ring-2 focus-visible:ring-primary-fg data-[state=open]:border-element-hover data-[state=open]:bg-element/70",
}

const NAVIGATION_KEYS = new Set(["Escape", "Tab"])

export function Picker<T extends string>({
  noun,
  options,
  value,
  label,
  onChange,
  onClear,
  variant = "title",
  align = "start",
  className,
}: {
  noun: string
  options: PickerOption<T>[]
  value: T | ""
  label: string
  onChange: (_value: T | "") => void
  onClear?: () => void
  variant?: keyof typeof TRIGGERS
  align?: "start" | "end"
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const query = search.trim().toLowerCase()
  const current = options.find((option) => option.id === value)
  const matches = options.filter(
    (option) =>
      option.id !== value &&
      (!query ||
        option.id.toLowerCase().includes(query) ||
        option.name.toLowerCase().includes(query))
  )
  const groups = [...new Set(matches.map((option) => option.group))].map(
    (group) => ({
      group,
      options: matches.filter((option) => option.group === group),
    })
  )
  const clearable = !!onClear && !!current
  const select = (next: T | "") => {
    setOpen(false)
    onChange(next)
  }
  const item = (option: PickerOption<T>) => (
    <DropdownMenu.Item
      key={option.id}
      onSelect={() => select(option.id)}
      onPointerMove={(event) => event.preventDefault()}
      onPointerLeave={(event) => event.preventDefault()}
      className="flex cursor-pointer items-center gap-2 rounded-md py-1.5 pr-3 pl-2 text-sm outline-none hover:bg-subtle data-[highlighted]:bg-subtle"
    >
      {option.icon}
      <Tooltip content={option.hint}>
        <span className="flex-1 truncate">{option.name}</span>
      </Tooltip>
      {option.trailing}
    </DropdownMenu.Item>
  )

  return (
    <DropdownMenu.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        setSearch("")
      }}
    >
      {variant === "field" ? (
        <span className={cx("relative inline-flex", className)}>
          <Tooltip content={current?.hint ?? `Select ${noun}`}>
            <DropdownMenu.Trigger
              ref={triggerRef}
              aria-label={label}
              className={cx(TRIGGERS.field, "w-full", clearable && "pr-8")}
            >
              {current?.icon}
              <span
                className={cx("flex-1 truncate", !current && "text-fg-muted")}
              >
                {current?.name ?? label}
              </span>
              {clearable ? null : (
                <ChevronsUpDown
                  aria-hidden
                  className="size-3.5 text-fg-muted"
                />
              )}
            </DropdownMenu.Trigger>
          </Tooltip>
          {clearable ? (
            <Tooltip content={`Clear ${noun}`}>
              <button
                type="button"
                aria-label={`Clear ${noun}`}
                onClick={() => {
                  onClear?.()
                  triggerRef.current?.focus()
                }}
                className="absolute top-1/2 right-1 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded text-fg-muted outline-none hover:bg-subtle hover:text-fg focus-visible:ring-2 focus-visible:ring-primary-fg"
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </Tooltip>
          ) : null}
        </span>
      ) : (
        <DropdownMenu.Trigger className={cx(TRIGGERS.title, className)}>
          {current?.name ?? label}
          <ChevronsUpDown aria-hidden className="size-4 text-fg-muted" />
        </DropdownMenu.Trigger>
      )}
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          sideOffset={6}
          onFocus={(event) => {
            const from = event.relatedTarget
            if (!(from instanceof Node && event.currentTarget.contains(from)))
              inputRef.current?.focus()
          }}
          className="z-30 flex max-h-[min(26rem,var(--radix-dropdown-menu-content-available-height))] w-72 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-md border border-line-strong bg-surface shadow-lg"
        >
          <label className="relative shrink-0 border-b border-line">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-fg-muted"
            />
            <input
              ref={inputRef}
              aria-label={`Search ${noun}s`}
              placeholder={`Search ${noun}s`}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && matches[0]) select(matches[0].id)
                if (event.key === "ArrowDown") {
                  event.preventDefault()
                  listRef.current
                    ?.querySelector<HTMLElement>("[role=menuitem]")
                    ?.focus()
                }
                if (!NAVIGATION_KEYS.has(event.key)) event.stopPropagation()
              }}
              className="h-10 w-full bg-transparent pr-3 pl-8 text-sm outline-none placeholder:text-fg-muted"
            />
          </label>
          <div ref={listRef} className="overflow-y-auto p-1">
            {groups.map(({ group, options: members }) =>
              group ? (
                <DropdownMenu.Group key={group}>
                  <DropdownMenu.Label className="px-2 pt-2 pb-1 text-[10px] font-semibold tracking-wider text-fg-muted uppercase">
                    {group}
                  </DropdownMenu.Label>
                  {members.map(item)}
                </DropdownMenu.Group>
              ) : (
                members.map(item)
              )
            )}
            {matches.length ? null : (
              <div className="px-2 py-6 text-center text-sm text-fg-muted">
                No {noun}s
              </div>
            )}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
