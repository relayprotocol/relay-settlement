"use client"

import { useState } from "react"

interface CopyableAddressProps {
  value: string
  label?: string
  full?: boolean
}

export function CopyableAddress({
  value,
  label,
  full = false,
}: CopyableAddressProps) {
  const [copied, setCopied] = useState(false)

  const displayValue = full
    ? value
    : `${value.slice(0, 6)}...${value.slice(-4)}`

  const handleCopy = async () => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="inline-flex items-center gap-2">
      {label && <span className="text-neutral-500">{label}:</span>}
      <span className="font-mono text-sm text-neutral-700">{displayValue}</span>
      <button
        onClick={handleCopy}
        className="p-1 hover:bg-neutral-100 rounded transition-colors"
        title="Copy to clipboard"
      >
        {copied ? (
          <svg
            className="w-4 h-4 text-green-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5 13l4 4L19 7"
            />
          </svg>
        ) : (
          <svg
            className="w-4 h-4 text-neutral-400 hover:text-neutral-600"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
            />
          </svg>
        )}
      </button>
    </div>
  )
}
