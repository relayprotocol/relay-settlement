import { useRef } from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"

const INTENT_DELAY_MS = 100

export type Prefetch = (queryClient: QueryClient) => Array<Promise<unknown>>

export const usePrefetchOnIntent = () => {
  const queryClient = useQueryClient()
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  return (prefetch: Prefetch) => {
    const start = () => void Promise.allSettled(prefetch(queryClient))
    return {
      onFocus: start,
      onPointerEnter: () => {
        timer.current = setTimeout(start, INTENT_DELAY_MS)
      },
      onPointerLeave: () => clearTimeout(timer.current),
    }
  }
}
