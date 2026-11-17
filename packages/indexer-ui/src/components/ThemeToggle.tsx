import { Moon, Sun } from "lucide-react"
import { setTheme, useTheme } from "../theme"
import { IconButton } from "./ui"

export default function ThemeToggle() {
  const theme = useTheme()
  const next = theme === "dark" ? "light" : "dark"
  const Icon = theme === "dark" ? Sun : Moon

  return (
    <IconButton label={`Switch to ${next} mode`} onClick={() => setTheme(next)}>
      <Icon aria-hidden strokeWidth={1.75} className="size-[18px]" />
    </IconButton>
  )
}
