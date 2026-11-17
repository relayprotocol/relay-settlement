import { useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { Link, matchPath, useLocation } from "react-router"
import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { Ellipsis } from "lucide-react"
import { SECTIONS } from "../navigation"
import { usePrefetchOnIntent } from "../prefetch"
import { cx } from "../utils"

const ITEM_GAP = 6

const fittingItems = (width: number, [more = 0, ...widths]: number[]) => {
  const ends = widths.map((_, index) =>
    widths
      .slice(0, index + 1)
      .reduce((end, itemWidth) => end + itemWidth + ITEM_GAP, -ITEM_GAP)
  )
  return (ends.at(-1) ?? 0) <= width
    ? widths.length
    : ends.filter((end) => end + ITEM_GAP + more <= width).length
}

const ITEM =
  "group relative flex w-15 shrink-0 cursor-pointer flex-col items-center gap-0.5 rounded-md px-1 py-[7px] text-[11px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary-fg focus-visible:ring-inset"

const SEPARATOR =
  "before:absolute before:top-1/2 before:-left-[3.5px] before:h-5 before:w-px before:-translate-y-1/2 before:rounded-full before:bg-line first:before:hidden"

const LABEL = "max-w-full truncate leading-tight"

const itemState = (active: boolean) =>
  active
    ? "bg-primary-bg/80 text-primary-on-bg inset-ring inset-ring-primary-line"
    : "text-fg-subtle hover:bg-element hover:text-fg hover:inset-ring hover:inset-ring-line active:bg-element-hover"

const ICON = "size-[18px]"

export default function NavBar({ actions }: { actions: ReactNode }) {
  const listRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const [visibleCount, setVisibleCount] = useState(SECTIONS.length)
  const { pathname } = useLocation()
  const prefetchProps = usePrefetchOnIntent()

  useLayoutEffect(() => {
    const list = listRef.current
    const measure = measureRef.current
    if (!list || !measure) return
    const update = () =>
      setVisibleCount(
        fittingItems(
          list.clientWidth,
          Array.from(
            measure.children,
            (item) => item.getBoundingClientRect().width
          )
        )
      )
    update()
    const observer = new ResizeObserver(update)
    observer.observe(list)
    for (const item of measure.children) observer.observe(item)
    return () => observer.disconnect()
  }, [])

  const items = SECTIONS.map(({ end = false, ...item }) => ({
    ...item,
    active: matchPath({ end, path: item.path }, pathname) != null,
  }))
  const visible = items.slice(0, visibleCount)
  const overflow = items.slice(visibleCount)
  const overflowActive = overflow.some((item) => item.active)

  return (
    <nav
      aria-label="Main"
      className="relative flex items-center gap-2 rounded-lg border border-line bg-surface p-1"
    >
      <div
        ref={measureRef}
        aria-hidden
        className="pointer-events-none invisible absolute flex w-0 gap-1.5 overflow-hidden"
      >
        {[{ icon: Ellipsis, label: "More" }, ...SECTIONS].map(
          ({ icon: Icon, label }) => (
            <span key={label} className={ITEM}>
              <Icon strokeWidth={1.75} className={ICON} />
              <span className={LABEL}>{label}</span>
            </span>
          )
        )}
      </div>
      <div
        ref={listRef}
        className="flex min-w-0 flex-1 gap-1.5 overflow-hidden"
      >
        {visible.map(({ active, icon: Icon, label, prefetch, path }) => (
          <Link
            key={path}
            to={path}
            aria-current={active ? "page" : undefined}
            className={cx(ITEM, SEPARATOR, itemState(active))}
            {...prefetchProps(prefetch)}
          >
            <Icon aria-hidden strokeWidth={1.75} className={ICON} />
            <span className={LABEL}>{label}</span>
          </Link>
        ))}
        {overflow.length ? (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              className={cx(
                ITEM,
                SEPARATOR,
                itemState(overflowActive),
                !overflowActive &&
                  "data-[state=open]:bg-element data-[state=open]:text-fg data-[state=open]:inset-ring data-[state=open]:inset-ring-line"
              )}
            >
              <Ellipsis aria-hidden strokeWidth={1.75} className={ICON} />
              <span className={LABEL}>More</span>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="start"
                sideOffset={6}
                className="z-30 min-w-44 rounded-md border border-line-strong bg-surface p-1 shadow-lg"
              >
                {overflow.map(
                  ({ active, icon: Icon, label, prefetch, path }) => (
                    <DropdownMenu.Item key={path} asChild>
                      <Link
                        to={path}
                        aria-current={active ? "page" : undefined}
                        {...prefetchProps(prefetch)}
                        className={cx(
                          "flex cursor-pointer items-center gap-2 rounded-md p-2 text-sm font-medium outline-none data-[highlighted]:bg-subtle",
                          active ? "text-primary-strong" : "text-fg"
                        )}
                      >
                        <Icon
                          aria-hidden
                          strokeWidth={1.75}
                          className={cx(
                            "size-4",
                            active ? "text-primary-fg" : "text-fg-subtle"
                          )}
                        />
                        {label}
                      </Link>
                    </DropdownMenu.Item>
                  )
                )}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 pr-1">{actions}</div>
    </nav>
  )
}
