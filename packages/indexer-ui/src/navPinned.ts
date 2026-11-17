import { useState } from "react"
import { readStorage, writeStorage } from "./storage"

const STORAGE_KEY = "nav-pinned"

export const useNavPinned = () => {
  const [pinned, setPinned] = useState(
    () => readStorage(STORAGE_KEY) !== "false"
  )
  const update = (value: boolean) => {
    setPinned(value)
    writeStorage(STORAGE_KEY, String(value))
  }
  return [pinned, update] as const
}
