import { useEffect, useState, useSyncExternalStore } from "react"
import {
  focusManager,
  onlineManager,
  useQueryClient,
  type Query,
} from "@tanstack/react-query"
import { REFRESH_INTERVAL_MS } from "./queryClient"

export type AutoRefresh = { startedAt: number; refresh: () => void }

const subscribe = (onChange: () => void) => {
  const unsubscribeFocus = focusManager.subscribe(onChange)
  const unsubscribeOnline = onlineManager.subscribe(onChange)
  return () => {
    unsubscribeFocus()
    unsubscribeOnline()
  }
}

const canRefresh = () => focusManager.isFocused() && onlineManager.isOnline()

const retryDue = (query: Query) => {
  if (query.state.status !== "error") return true
  const staleTime = Math.max(
    REFRESH_INTERVAL_MS,
    ...query.observers.map(({ options }) =>
      typeof options.staleTime === "number" ? options.staleTime : 0
    )
  )
  return Date.now() - query.state.errorUpdatedAt >= staleTime
}

export const useAutoRefresh = (): AutoRefresh => {
  const queryClient = useQueryClient()
  const running = useSyncExternalStore(subscribe, canRefresh)
  const [startedAt, setStartedAt] = useState(Date.now)

  useEffect(() => {
    if (!running) return
    const timer = setTimeout(
      () => {
        void queryClient.refetchQueries(
          { predicate: retryDue, stale: true, type: "active" },
          { cancelRefetch: false }
        )
        setStartedAt(Date.now())
      },
      startedAt + REFRESH_INTERVAL_MS - Date.now()
    )
    return () => clearTimeout(timer)
  }, [running, startedAt, queryClient])

  const refresh = () => {
    void queryClient.refetchQueries({
      predicate: (query) => !query.meta?.gentle,
      type: "active",
    })
    setStartedAt(Date.now())
  }

  return { refresh, startedAt }
}
