"use client"

import * as React from "react"
import { Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"
import { Button } from "@/components/ui/button"

const subscribe = () => () => {}

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme, resolvedTheme } = useTheme()
  const mounted = React.useSyncExternalStore(subscribe, () => true, () => false)

  if (!mounted) {
    return (
      <Button
        variant="ghost"
        size="icon-sm"
        className={className}
        aria-label="Toggle theme"
      >
        <span className="size-4" />
      </Button>
    )
  }

  const currentTheme = theme === "system" ? resolvedTheme : theme
  const isDark = currentTheme === "dark"

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className={className}
      onClick={() => setTheme(isDark ? "light" : "dark")}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label="Toggle theme"
    >
      {isDark ? (
        <Sun className="size-4 text-amber-400 transition-transform hover:rotate-45" />
      ) : (
        <Moon className="size-4 text-zinc-700 transition-transform hover:-rotate-12" />
      )}
    </Button>
  )
}
