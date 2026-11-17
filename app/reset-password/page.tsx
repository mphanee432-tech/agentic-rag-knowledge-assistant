"use client"

import { Suspense, useEffect, useState, type FormEvent } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { createBrowserClient } from "@/lib/supabase/client"
import { isDualProjectConfigured, normalizeWorkspaceScope, type WorkspaceScope } from "@/lib/supabase/config"
import { useChatStore } from "@/lib/store/chat-store"

type RecoveryStatus = "checking" | "ready" | "invalid" | "success"

function ResetPasswordForm() {
  const searchParams = useSearchParams()
  const requestedWorkspaceParam = searchParams.get("workspace")
  const initialWorkspace = normalizeWorkspaceScope(requestedWorkspaceParam, "personal")
  const hasLinkError = Boolean(searchParams.get("error") || searchParams.get("error_code"))
  const [resolvedWorkspace, setResolvedWorkspace] = useState<WorkspaceScope>(initialWorkspace)
  const [status, setStatus] = useState<RecoveryStatus>("checking")
  const [error, setError] = useState("")
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (hasLinkError) {
      return
    }
    let active = true

    async function verifyRecoverySession() {
      try {
        const candidates: WorkspaceScope[] =
          requestedWorkspaceParam === "personal" || requestedWorkspaceParam === "enterprise"
            ? [requestedWorkspaceParam]
            : isDualProjectConfigured()
              ? ["personal", "enterprise"]
              : ["personal"]

        for (const candidate of candidates) {
          const supabase = createBrowserClient(candidate)
          const { data, error: userError } = await supabase.auth.getUser()
          if (!active) return
          if (!userError && data.user) {
            setResolvedWorkspace(candidate)
            setStatus("ready")
            return
          }
        }

        setStatus("invalid")
        setError("This password reset link is invalid or has expired. Please request a new one.")
      } catch {
        if (!active) return
        setStatus("invalid")
        setError("Unable to verify your password reset session. Please request a new reset link.")
      }
    }

    void verifyRecoverySession()
    return () => {
      active = false
    }
  }, [hasLinkError, requestedWorkspaceParam])

  const effectiveStatus: RecoveryStatus = hasLinkError ? "invalid" : status
  const effectiveError = hasLinkError
    ? "This password reset link is invalid or has expired. Please request a new one."
    : error

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")

    const form = new FormData(event.currentTarget)
    const password = String(form.get("password") ?? "")
    const confirmPassword = String(form.get("confirmPassword") ?? "")

    if (password.length < 6) {
      setError("Password must be at least 6 characters.")
      return
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.")
      return
    }

    setPending(true)
    try {
      const supabase = createBrowserClient(resolvedWorkspace)
      const { error: updateError } = await supabase.auth.updateUser({ password })
      if (updateError) {
        setError(updateError.message || "Unable to update password. Please request a new reset link.")
        return
      }
      await supabase.auth.signOut({ scope: "local" }).catch(() => null)
      useChatStore.getState().setAccount(null)
      setStatus("success")
    } catch {
      setError("Unable to update password right now. Please try again.")
    } finally {
      setPending(false)
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold">Set new password</h1>

        {effectiveStatus === "checking" && (
          <p className="text-sm text-muted-foreground">Verifying password reset link…</p>
        )}

        {effectiveStatus === "invalid" && (
          <div className="space-y-4">
            <p role="alert" className="text-sm text-destructive">
              {effectiveError}
            </p>
            <Link href={`/login?workspace=${resolvedWorkspace}`} className="inline-block border rounded px-4 py-2 text-sm">
              Return to sign in
            </Link>
          </div>
        )}

        {effectiveStatus === "ready" && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <label className="block">
              New password
              <input
                className="block w-full border rounded p-2"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={6}
                required
              />
            </label>

            <label className="block">
              Confirm new password
              <input
                className="block w-full border rounded p-2"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                minLength={6}
                required
              />
            </label>

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}

            <button disabled={pending} className="border rounded px-4 py-2">
              {pending ? "Updating…" : "Update password"}
            </button>
          </form>
        )}

        {effectiveStatus === "success" && (
          <div className="space-y-4">
            <p role="status" className="text-sm">
              Your password has been updated. You can now sign in with your new password.
            </p>
            <Link href={`/login?workspace=${resolvedWorkspace}`} className="inline-block border rounded px-4 py-2 text-sm">
              Return to sign in
            </Link>
          </div>
        )}
      </div>
    </main>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen flex items-center justify-center p-6">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </main>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  )
}

