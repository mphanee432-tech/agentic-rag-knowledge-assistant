"use client"

import { useState, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { DEMO_DEPARTMENTS, isDemoDepartment } from "@/lib/utils"

export function EnterpriseOnboardCard() {
  const router = useRouter()
  const [department, setDepartment] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")
    setSuccess("")

    if (!isDemoDepartment(department)) {
      setError("Please select a valid DeccanBridge department.")
      return
    }

    setPending(true)
    try {
      const response = await fetch("/api/enterprise/onboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ department }),
      })
      const payload = (await response.json().catch(() => null)) as
        | { departmentName?: string; role?: string; error?: string }
        | null
      if (!response.ok) {
        setError(payload?.error || "Unable to complete employee onboarding.")
        return
      }
      const confirmedDept = payload?.departmentName || department
      setSuccess(
        `Enterprise Employee membership activated for DeccanBridge Software (${confirmedDept}).`,
      )
      router.replace("/?tab=enterprise&enrolled=1")
      router.refresh()
    } catch {
      setError("Unable to complete employee onboarding. Please retry.")
    } finally {
      setPending(false)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Complete demo department enrollment"
      className="mt-6 w-full max-w-md rounded-xl border border-border bg-card p-5 text-left space-y-3 shadow-2xs"
    >
      <div>
        <h3 className="text-sm font-semibold text-foreground">
          Complete One-Time Demo Department Enrollment
        </h3>
        <p className="text-xs text-muted-foreground mt-1">
          Select your DeccanBridge Software department to activate standard Employee membership for this account.
        </p>
      </div>

      <label className="block space-y-1 text-xs font-medium text-foreground">
        <span>Department</span>
        <select
          name="department"
          value={department}
          onChange={(event) => setDepartment(event.target.value)}
          disabled={pending}
          required
          className="block w-full rounded-md border bg-background p-2 text-sm"
        >
          <option value="" disabled>
            Select a department
          </option>
          {DEMO_DEPARTMENTS.map((dept) => (
            <option key={dept} value={dept}>
              {dept}
            </option>
          ))}
        </select>
      </label>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {success && (
        <p role="status" className="text-xs text-emerald-700 dark:text-emerald-400">
          {success}
        </p>
      )}

      <Button type="submit" size="sm" disabled={pending || !department} className="w-full">
        {pending ? "Activating membership…" : "Activate Employee Membership"}
      </Button>
    </form>
  )
}

