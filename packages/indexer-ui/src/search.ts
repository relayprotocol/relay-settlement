import { useEffect, useState, type ChangeEvent } from "react"

const SEARCH_DELAY_MS = 250

export const useSearch = () => {
  const [value, setValue] = useState("")
  const [query, setQuery] = useState("")
  const next = value.trim()
  if (!next && query) setQuery("")

  useEffect(() => {
    const timer = setTimeout(() => setQuery(next), SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [next])

  return {
    input: {
      onChange: (event: ChangeEvent<HTMLInputElement>) =>
        setValue(event.target.value),
      value,
    },
    query,
  }
}
