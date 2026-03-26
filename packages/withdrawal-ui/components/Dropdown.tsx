"use client"

import { useState, useRef, useEffect, type ReactNode } from "react"

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
}

export function Dropdown({ trigger, items }: DropdownProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

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

  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen(!open)}>{trigger}</div>

      {open && (
        <div
          className="absolute z-50 mt-1 w-full bg-white rounded-card border border-gray-200 shadow-card overflow-y-auto"
          style={{ maxHeight: 280 }}
        >
          {items.map((item) => (
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
          ))}
        </div>
      )}
    </div>
  )
}
