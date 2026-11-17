import { useState } from "react"
import { useIsFetching } from "@tanstack/react-query"
import { RefreshCw } from "lucide-react"
import { REFRESH_INTERVAL_MS } from "../queryClient"
import type { AutoRefresh } from "../refresh"
import { cx } from "../utils"
import { IconButton } from "./ui"

export default function RefreshButton({ startedAt, refresh }: AutoRefresh) {
  const fetching = useIsFetching({ type: "active" }) > 0
  const [spinning, setSpinning] = useState(fetching)
  if (fetching && !spinning) setSpinning(true)

  return (
    <IconButton
      label="Refetch indexer data"
      onClick={refresh}
      className="group relative"
    >
      <svg
        aria-hidden
        viewBox="0 0 36 36"
        className="absolute inset-0 size-full -rotate-90"
      >
        <circle
          cx="18"
          cy="18"
          r="14"
          fill="none"
          strokeWidth="1.5"
          className="stroke-line transition-colors group-hover:stroke-line-strong"
        />
        <circle
          key={startedAt}
          cx="18"
          cy="18"
          r="14"
          fill="none"
          strokeWidth="1.5"
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={100}
          className="stroke-primary-on-bg/80"
          style={{
            animation: `countdown ${REFRESH_INTERVAL_MS}ms linear forwards`,
          }}
        />
      </svg>
      <RefreshCw
        aria-hidden
        strokeWidth={1.75}
        className={cx("size-4", spinning && "animate-spin")}
        onAnimationIteration={() => {
          if (!fetching) setSpinning(false)
        }}
      />
    </IconButton>
  )
}
