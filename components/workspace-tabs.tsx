"use client"

import Link from "next/link"
import { Building2, User } from "lucide-react"

export type WorkspaceTab = "personal" | "enterprise"

interface WorkspaceTabsProps {
  activeTab: WorkspaceTab
}

const TAB_ITEMS: Array<{
  id: WorkspaceTab
  href: string
  label: string
  description: string
  icon: typeof User
  activeClasses: string
  activeIconClasses: string
  activeDescClasses: string
}> = [
  {
    id: "personal",
    href: "/?tab=personal",
    label: "Personal RAG",
    description: "Your private documents",
    icon: User,
    activeClasses:
      "border-blue-600 bg-blue-50/90 text-zinc-950 shadow-sm dark:border-blue-400 dark:bg-blue-950/60 dark:text-zinc-50",
    activeIconClasses:
      "bg-blue-600 text-white dark:bg-blue-500 dark:text-white",
    activeDescClasses: "text-zinc-700 dark:text-zinc-200",
  },
  {
    id: "enterprise",
    href: "/?tab=enterprise",
    label: "Enterprise RAG",
    description: "Company knowledge",
    icon: Building2,
    activeClasses:
      "border-emerald-600 bg-emerald-50/90 text-zinc-950 shadow-sm dark:border-emerald-400 dark:bg-emerald-950/60 dark:text-zinc-50",
    activeIconClasses:
      "bg-emerald-600 text-white dark:bg-emerald-500 dark:text-white",
    activeDescClasses: "text-zinc-700 dark:text-zinc-200",
  },
]

export function WorkspaceTabs({ activeTab }: WorkspaceTabsProps) {
  return (
    <nav
      aria-label="RAG workspace navigation"
      className="grid w-full sm:w-auto grid-cols-2 gap-1.5 sm:gap-2 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-100/90 dark:bg-zinc-900/90 p-1.5 shadow-2xs"
    >
      {TAB_ITEMS.map((item) => {
        const isActive = activeTab === item.id
        const Icon = item.icon

        return (
          <Link
            key={item.id}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            className={`group min-w-0 flex items-center gap-2 sm:gap-3 rounded-lg border-2 px-2.5 py-2 sm:px-4 sm:py-2 sm:min-w-[190px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:focus-visible:ring-zinc-100 focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
              isActive
                ? item.activeClasses
                : "border-transparent bg-transparent text-zinc-700 hover:bg-white/75 hover:text-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-800/70 dark:hover:text-zinc-50"
            }`}
          >
            <span
              className={`size-7 sm:size-8 rounded-lg flex items-center justify-center shrink-0 transition-colors ${
                isActive
                  ? item.activeIconClasses
                  : "bg-zinc-200/80 text-zinc-600 group-hover:bg-zinc-200 group-hover:text-zinc-900 dark:bg-zinc-800 dark:text-zinc-400 dark:group-hover:bg-zinc-700 dark:group-hover:text-zinc-100"
              }`}
            >
              <Icon className="size-3.5 sm:size-4" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex flex-col">
              <span className="text-xs sm:text-sm font-semibold leading-tight tracking-tight">
                {item.label}
              </span>
              <span
                className={`text-[10px] sm:text-[11px] leading-tight mt-0.5 ${
                  isActive
                    ? item.activeDescClasses
                    : "text-zinc-500 dark:text-zinc-400"
                }`}
              >
                {item.description}
              </span>
            </span>
          </Link>
        )
      })}
    </nav>
  )
}
