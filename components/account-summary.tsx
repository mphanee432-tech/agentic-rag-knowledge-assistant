import { Badge } from "@/components/ui/badge"
import type { AccountSummaryInfo } from "@/lib/account-summary"

interface AccountSummaryProps {
  account: AccountSummaryInfo
}

export function AccountSummary({ account }: AccountSummaryProps) {
  const isActive = account.accessStatus === "Active"

  return (
    <section
      aria-label="Authenticated account details"
      className="px-6 py-2 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/40 flex flex-wrap items-center justify-between gap-2 text-xs"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-zinc-700 dark:text-zinc-300">
        <span>
          Signed in as <strong className="font-medium text-zinc-900 dark:text-zinc-100">{account.email}</strong>
        </span>
        {account.organizationName && (
          <span className="text-zinc-500 dark:text-zinc-400">
            Organization:{" "}
            <strong className="font-medium text-zinc-800 dark:text-zinc-200">{account.organizationName}</strong>
          </span>
        )}
        {account.departmentName && (
          <span className="text-zinc-500 dark:text-zinc-400">
            Department:{" "}
            <strong className="font-medium text-zinc-800 dark:text-zinc-200">{account.departmentName}</strong>
          </span>
        )}
        <span className="text-zinc-500 dark:text-zinc-400">
          Role:{" "}
          <strong className="font-medium text-zinc-800 dark:text-zinc-200">
            {account.role ?? "None"}
          </strong>
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant="outline"
          className={
            isActive
              ? "text-[11px] border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              : "text-[11px] border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
          }
        >
          Enterprise membership: {account.accessStatus}
        </Badge>
        <Badge
          variant="outline"
          className={
            account.jiraAccessAvailable
              ? "text-[11px] border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              : "text-[11px] border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400"
          }
        >
          {account.jiraAccessAvailable ? "Jira Access: Enabled" : "Jira Access: Disabled"}
        </Badge>
      </div>
    </section>
  )
}
