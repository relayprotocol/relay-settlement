import { onlineManager, QueryClient } from "@tanstack/react-query"
import { shouldRetry } from "./api/client"

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: { gentle?: boolean; inline?: boolean; quiet?: boolean }
  }
}

export const REFRESH_INTERVAL_MS = 10_000

onlineManager.setOnline(navigator.onLine)

export const queryClient = new QueryClient({
  defaultOptions: {
    mutations: { networkMode: "always" },
    queries: {
      gcTime: 60 * 60_000,
      networkMode: "always",
      refetchOnReconnect: true,
      refetchOnWindowFocus: false,
      retry: shouldRetry,
      staleTime: REFRESH_INTERVAL_MS / 2,
    },
  },
})
