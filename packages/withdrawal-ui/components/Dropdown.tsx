"use client"

import { useState, useRef, useEffect, useMemo, type ReactNode } from "react"

interface DropdownItem {
  key: string
  icon?: ReactNode
  label: string
  sublabel?: string
  onClick: () => void
}

interface DropdownProps {
  trigger: ReactNode
  items: DropdownItem[]
  searchable?: boolean
  searchPlaceholder?: string
  onOpen?: () => void
}

export function Dropdown({
  trigger,
  items,
  searchable = false,
  searchPlaceholder = "Search...",
  onOpen,
}: DropdownProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Auto-enable search when many items
  const showSearch = searchable || items.length > 8

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [open])

  // Focus search input when opening
  useEffect(() => {
    if (open && showSearch) {
      setTimeout(() => inputRef.current?.focus(), 0)
    }
    if (!open) setSearch("")
  }, [open, showSearch])

  const filtered = useMemo(() => {
    if (!search.trim()) return items
    const q = search.toLowerCase()
    return items.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.sublabel?.toLowerCase().includes(q) ||
        item.key.toLowerCase().includes(q)
    )
  }, [items, search])

  return (
    <div ref={ref} className="relative">
      <div
        onClick={() => {
          const next = !open
          setOpen(next)
          if (next) onOpen?.()
        }}
      >
        {trigger}
      </div>

      {open && (
        <div className="absolute z-50 mt-1 w-full bg-white rounded-card border border-gray-200 shadow-card overflow-hidden">
          {showSearch && (
            <div className="p-2 border-b border-gray-100">
              <input
                ref={inputRef}
                type="text"
                className="w-full px-3 py-2 text-sm bg-gray-50 rounded-input outline-none focus:bg-white focus:ring-1 focus:ring-primary-300"
                placeholder={searchPlaceholder}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          )}

          <div className="overflow-y-auto" style={{ maxHeight: 240 }}>
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-center text-sm text-subtle">
                No results
              </div>
            ) : (
              filtered.map((item) => (
                <button
                  key={item.key}
                  className="w-full px-3 py-2 flex items-center gap-2 hover:bg-gray-50 text-left transition-colors"
                  onClick={() => {
                    item.onClick()
                    setOpen(false)
                  }}
                >
                  {item.icon}
                  <span className="text-sm font-medium text-default">
                    {item.label}
                  </span>
                  {item.sublabel && (
                    <span className="text-xs text-subtle">{item.sublabel}</span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
