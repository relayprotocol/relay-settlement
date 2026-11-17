import { useSyncExternalStore } from "react"

const listeners = new Set<() => void>()
let now = Date.now()
let timer: ReturnType<typeof setInterval> | undefined

const tick = () => {
  now = Date.now()
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  if (!timer) {
    now = Date.now()
    timer = setInterval(tick, 1000)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size) return
    clearInterval(timer)
    timer = undefined
  }
}

export const useNow = () => useSyncExternalStore(subscribe, () => now)
