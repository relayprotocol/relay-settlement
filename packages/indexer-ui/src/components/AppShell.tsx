import { useSyncExternalStore } from "react"
import {
  Outlet,
  ScrollRestoration,
  useLocation,
  useNavigate,
} from "react-router"
import { useQueryClient, type Query } from "@tanstack/react-query"
import { ApiError, ConnectionError } from "../api/client"
import { ArrowLeft, Pin, TriangleAlert } from "lucide-react"
import { useNavPinned } from "../navPinned"
import { useAutoRefresh } from "../refresh"
import { cx } from "../utils"
import NavBar from "./NavBar"
import RefreshButton from "./RefreshButton"
import ThemeToggle from "./ThemeToggle"
import { IconButton } from "./ui"

const DETAIL_SECTIONS = new Set(["hub"])

export default function AppShell() {
  const [pinned, setPinned] = useNavPinned()
  const autoRefresh = useAutoRefresh()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [section, ...rest] = pathname.split("/").filter(Boolean)
  const back =
    section && DETAIL_SECTIONS.has(section) && rest.length
      ? `/${section}`
      : undefined

  return (
    <div className="mx-auto flex w-full max-w-screen-2xl flex-col px-3 pb-12 sm:px-6">
      <ScrollRestoration />
      <header
        className={cx(
          "z-20 flex flex-col gap-2 bg-app pt-2 pb-3",
          pinned &&
            "sticky top-0 after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-0.5 after:bg-linear-to-b after:from-app after:to-transparent"
        )}
      >
        <NavBar
          actions={
            <>
              {back ? (
                <IconButton label="Back" onClick={() => navigate(back)}>
                  <ArrowLeft
                    aria-hidden
                    strokeWidth={1.75}
                    className="size-[18px]"
                  />
                </IconButton>
              ) : null}
              <IconButton
                label={pinned ? "Unpin navigation" : "Pin navigation"}
                pressed={pinned}
                onClick={() => setPinned(!pinned)}
              >
                <Pin aria-hidden strokeWidth={1.75} className="size-[18px]" />
              </IconButton>
              <ThemeToggle />
              <RefreshButton {...autoRefresh} />
            </>
          }
        />
        <QueryErrors />
      </header>
      <main className="flex flex-col gap-4 pt-1">
        <Outlet />
      </main>
    </div>
  )
}

const shownError = ({ meta, state }: Query) =>
  state.status === "error" &&
  state.error &&
  !(state.error instanceof ConnectionError) &&
  !meta?.quiet &&
  !(meta?.inline && state.error instanceof ApiError && state.error.status < 500)
    ? [state.error.message]
    : []

const activeErrors = (queries: Query[]) =>
  [...new Set(queries.flatMap(shownError))].join("\n")

const settledAt = ({ state }: Query) =>
  Math.max(state.dataUpdatedAt, state.errorUpdatedAt)

const connectionError = (queries: Query[]) => {
  const error = queries.reduce<Query | undefined>(
    (latest, query) =>
      latest && settledAt(latest) >= settledAt(query) ? latest : query,
    undefined
  )?.state.error
  return error instanceof ConnectionError ? error.message : ""
}

const useActiveQueries = <T,>(select: (queries: Query[]) => T) => {
  const cache = useQueryClient().getQueryCache()
  return useSyncExternalStore(
    (onChange) => cache.subscribe(onChange),
    () => select(cache.findAll({ type: "active" }))
  )
}

function QueryErrors() {
  const connection = useActiveQueries(connectionError)
  const errors = useActiveQueries(activeErrors)
  const lines = [connection, ...errors.split("\n")].filter(Boolean)
  if (!lines.length) return null
  return (
    <div
      role="alert"
      className="flex gap-3 rounded-lg border border-error-line bg-error-bg px-4 py-3 text-sm text-error-fg"
    >
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <ul className="flex flex-col gap-1 wrap-anywhere">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  )
}
