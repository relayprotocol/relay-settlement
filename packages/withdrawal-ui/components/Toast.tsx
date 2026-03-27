"use client"

import { useEffect, useState, useCallback } from "react"

interface ToastProps {
  title: string
  description?: string
  type?: "info" | "success" | "error"
  duration?: number
  onDismiss: () => void
}

const icons = {
  info: (
    <div className="w-9 h-9 rounded-xl bg-primary-50 flex items-center justify-center flex-shrink-0">
      <svg
        className="w-5 h-5 text-primary-500"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    </div>
  ),
  success: (
    <div className="w-9 h-9 rounded-xl bg-green-50 flex items-center justify-center flex-shrink-0">
      <svg
        className="w-5 h-5 text-green-500"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    </div>
  ),
  error: (
    <div className="w-9 h-9 rounded-xl bg-red-50 flex items-center justify-center flex-shrink-0">
      <svg
        className="w-5 h-5 text-red-500"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    </div>
  ),
}

function Toast({
  title,
  description,
  type = "info",
  duration = 4500,
  onDismiss,
}: ToastProps) {
  const [visible, setVisible] = useState(false)

  const dismiss = useCallback(() => {
    setVisible(false)
    setTimeout(onDismiss, 300)
  }, [onDismiss])

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true))
    const timer = setTimeout(dismiss, duration)
    return () => clearTimeout(timer)
  }, [duration, dismiss])

  return (
    <div
      className={`flex items-start gap-3 bg-white rounded-2xl p-4 transition-all duration-300 ease-out ${
        visible ? "opacity-100 translate-x-0" : "opacity-0 translate-x-4"
      }`}
      style={{
        boxShadow:
          "0 8px 32px rgba(0, 0, 0, 0.1), 0 2px 8px rgba(0, 0, 0, 0.05)",
        width: 340,
      }}
    >
      {icons[type]}
      <div className="flex-1 min-w-0 pt-0.5">
        <p className="text-sm font-semibold text-default leading-tight">
          {title}
        </p>
        {description && (
          <p className="text-xs text-subtle mt-0.5 leading-snug">
            {description}
          </p>
        )}
      </div>
      <button
        className="flex-shrink-0 mt-0.5 p-0.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
        onClick={dismiss}
      >
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>
  )
}

// --- Toast manager ---

interface ToastOptions {
  title: string
  description?: string
  type?: "info" | "success" | "error"
}

let addToastFn: ((toast: ToastOptions) => void) | null = null

export function showToast(
  title: string,
  options?: { description?: string; type?: "info" | "success" | "error" }
) {
  addToastFn?.({
    title,
    description: options?.description,
    type: options?.type,
  })
}

interface ToastEntry extends ToastOptions {
  id: number
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastEntry[]>([])

  useEffect(() => {
    let nextId = 0
    addToastFn = (toast) => {
      setToasts((prev) => [...prev, { ...toast, id: nextId++ }])
    }
    return () => {
      addToastFn = null
    }
  }, [])

  const dismiss = (id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }

  return (
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-3 pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <Toast
            title={t.title}
            description={t.description}
            type={t.type}
            onDismiss={() => dismiss(t.id)}
          />
        </div>
      ))}
    </div>
  )
}
