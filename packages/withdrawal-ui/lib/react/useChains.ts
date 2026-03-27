"use client"

import { useState, useEffect, useCallback } from "react"
import { getChains, type ChainInfo } from "@/lib/core/withdrawal/chains"

export function useChains() {
  const [chains, setChains] = useState<ChainInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    setError(false)
    getChains()
      .then((c) => {
        setChains(c)
        setLoading(false)
      })
      .catch(() => {
        setLoading(false)
        setError(true)
      })
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return { chains, loading, error, retry: load }
}
