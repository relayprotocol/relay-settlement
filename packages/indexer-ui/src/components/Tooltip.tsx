import type { ReactElement, ReactNode } from "react"
import * as RadixTooltip from "@radix-ui/react-tooltip"
import { ArrowUpRight } from "lucide-react"

export const TooltipProvider = ({ children }: { children: ReactNode }) => (
  <RadixTooltip.Provider delayDuration={300}>{children}</RadixTooltip.Provider>
)

export function Tooltip({
  content,
  align = "center",
  children,
}: {
  content?: ReactNode
  align?: "start" | "center" | "end"
  children: ReactElement
}) {
  if (content == null || content === "") return children
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side="top"
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className="z-40 max-w-[min(32rem,calc(100vw-1rem))] rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-xs leading-snug font-normal text-fg shadow-lg wrap-anywhere whitespace-normal"
        >
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  )
}

export function LinkTooltip({ value, host }: { value: string; host?: string }) {
  return (
    <span className="flex flex-col gap-1">
      <span className="font-mono text-fg">{value}</span>
      {host ? (
        <span className="inline-flex items-center gap-1 text-fg-subtle">
          {host}
          <ArrowUpRight aria-hidden className="size-3" />
        </span>
      ) : null}
    </span>
  )
}
