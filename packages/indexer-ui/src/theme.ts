import { useSyncExternalStore } from "react"
import { readStorage, writeStorage } from "./storage"

export type Theme = "light" | "dark"

const STORAGE_KEY = "theme"
const DARK_QUERY = matchMedia("(prefers-color-scheme: dark)")
const listeners = new Set<() => void>()

const currentTheme = (): Theme =>
  document.documentElement.classList.contains("dark") ? "dark" : "light"

const applyTheme = (theme: Theme) => {
  document.documentElement.classList.toggle("dark", theme === "dark")
  document.documentElement.classList.toggle("light", theme === "light")
  for (const listener of listeners) listener()
}

DARK_QUERY.addEventListener("change", (event) => {
  if (!readStorage(STORAGE_KEY)) applyTheme(event.matches ? "dark" : "light")
})

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useTheme = () => useSyncExternalStore(subscribe, currentTheme)

export const setTheme = (theme: Theme) => {
  writeStorage(STORAGE_KEY, theme)
  applyTheme(theme)
}
