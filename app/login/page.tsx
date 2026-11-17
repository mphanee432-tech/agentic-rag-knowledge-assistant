"use client"
import { Suspense, useState, type FormEvent } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { createBrowserClient } from "@/lib/supabase/client"
import { normalizeWorkspaceScope, type WorkspaceScope } from "@/lib/supabase/config"
import { useChatStore } from "@/lib/store/chat-store"
import {
  DEMO_DEPARTMENTS,
  isDemoDepartment,
  PENDING_DEMO_DEPARTMENT_COOKIE,
  type DemoDepartment,
} from "@/lib/utils"

function setPendingDepartmentCookie(userId: string, department: DemoDepartment) {
  document.cookie = `${PENDING_DEMO_DEPARTMENT_COOKIE}=${userId}:${encodeURIComponent(department)}; path=/; max-age=86400; SameSite=Lax`
}

function clearPendingDepartmentCookie() {
  document.cookie = `${PENDING_DEMO_DEPARTMENT_COOKIE}=; path=/; max-age=0; SameSite=Lax`
}

function getPendingDepartmentCookie(userId: string): DemoDepartment | undefined {
  const prefix = `${PENDING_DEMO_DEPARTMENT_COOKIE}=${userId}:`
  const match = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(prefix))
  return DEMO_DEPARTMENTS.find((department) => encodeURIComponent(department) === match?.slice(prefix.length))
}

async function completeDemoOnboarding(department: DemoDepartment) {
  const response = await fetch("/api/enterprise/onboard", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ department }),
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(payload?.error || "Unable to complete employee onboarding.")
  }
  clearPendingDepartmentCookie()
}

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const initialWorkspace = normalizeWorkspaceScope(searchParams.get("workspace"), "personal")
  const [workspace, setWorkspace] = useState<WorkspaceScope>(initialWorkspace)
  const [mode, setMode] = useState<"signin" | "signup" | "forgot">("signin")
  const [demoJiraAccess, setDemoJiraAccess] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [pending, setPending] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError("")
    setNotice("")
    const form = new FormData(event.currentTarget)
    const email = String(form.get("email") ?? "").trim()
    const password = String(form.get("password") ?? "")
    const supabase = createBrowserClient(workspace)

    try {
      if (mode === "forgot") {
        if (!email) {
          setError("Please enter your email address.")
          return
        }
        const redirectTo = `${window.location.origin}/reset-password?workspace=${workspace}`
        const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo,
        })
        if (resetError && resetError.status === 429) {
          setError("Too many reset requests. Please wait a moment and try again.")
          return
        }
        setNotice("If an account exists for that email, we have sent a password reset link. Please check your inbox.")
        return
      }

      if (mode === "signin") {
        const { data, error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password,
        })
        if (signInError || !data.session) {
          setError("Unable to sign in. Check your email and password.")
          return
        }
        if (workspace === "personal") {
          useChatStore.getState().setAccount(null)
          router.replace("/?tab=personal")
          router.refresh()
          return
        }
        const cookieDept = getPendingDepartmentCookie(data.session.user.id)
        const metaDept = isDemoDepartment(data.session.user.user_metadata?.demo_department)
          ? data.session.user.user_metadata.demo_department
          : undefined
        const pendingDepartment = cookieDept ?? metaDept
        let newlyEnrolled = false
        if (pendingDepartment) {
          const response = await fetch("/api/enterprise/onboard", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ department: pendingDepartment }),
          })
          clearPendingDepartmentCookie()
          if (response.ok) {
            newlyEnrolled = true
          }
        }
        useChatStore.getState().setAccount(null)
        router.replace(newlyEnrolled ? "/?tab=enterprise&enrolled=1" : "/?tab=enterprise")
        router.refresh()
        return
      }

      if (workspace === "personal") {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email,
          password,
        })
        if (
          signUpError?.code === "user_already_exists" ||
          signUpError?.code === "email_exists" ||
          /already registered|already exists/i.test(signUpError?.message ?? "") ||
          data.user?.identities?.length === 0
        ) {
          setError("An account with this email already exists. Please sign in.")
          return
        }
        if (signUpError) {
          setError(signUpError.message || "Unable to sign up. Check your email and password.")
          return
        }
        if (!data.session) {
          setNotice("Account created. Please check your email to confirm your account, then sign in.")
          setMode("signin")
          return
        }
        useChatStore.getState().setAccount(null)
        router.replace("/?tab=personal")
        router.refresh()
        return
      }

      const selectedDepartment = String(form.get("department") ?? "").trim()
      if (!isDemoDepartment(selectedDepartment)) {
        setError("Please select a valid DeccanBridge department.")
        return
      }

      const { data, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            demo_jira_access: demoJiraAccess,
            demo_department: selectedDepartment,
          },
        },
      })

      if (
        signUpError?.code === "user_already_exists" ||
        signUpError?.code === "email_exists" ||
        /already registered|already exists/i.test(signUpError?.message ?? "") ||
        data.user?.identities?.length === 0
      ) {
        setError("An account with this email already exists. Please sign in.")
        return
      }
      if (signUpError) {
        setError(signUpError.message || "Unable to sign up. Check your email and password.")
        return
      }
      if (!data.session) {
        if (data.user?.id) {
          setPendingDepartmentCookie(data.user.id, selectedDepartment)
        }
        setNotice(
          "Account created. Please check your email to confirm your account, then sign in to complete department membership activation.",
        )
        setMode("signin")
        return
      }

      setPendingDepartmentCookie(data.session.user.id, selectedDepartment)
      await completeDemoOnboarding(selectedDepartment)
      setNotice(
        `Enterprise Employee membership activated for DeccanBridge Software (${selectedDepartment}).`,
      )
      useChatStore.getState().setAccount(null)
      router.replace("/?tab=enterprise&enrolled=1")
      router.refresh()
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : mode === "signin"
            ? "Sign-in is unavailable. Please retry."
            : mode === "forgot"
              ? "Password reset is unavailable. Please retry."
              : "Sign-up is unavailable. Please retry.",
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
        <div className="space-y-1.5">
          <span className="block text-xs font-medium text-muted-foreground">Workspace</span>
          <div className="flex border rounded overflow-hidden" role="group" aria-label="Workspace selection">
            <button
              type="button"
              onClick={() => {
                setWorkspace("personal")
                setError("")
                setNotice("")
              }}
              aria-pressed={workspace === "personal"}
              className={`flex-1 py-2 text-xs font-medium ${
                workspace === "personal" ? "bg-foreground text-background" : "bg-background"
              }`}
            >
              Personal RAG
            </button>
            <button
              type="button"
              onClick={() => {
                setWorkspace("enterprise")
                setError("")
                setNotice("")
              }}
              aria-pressed={workspace === "enterprise"}
              className={`flex-1 py-2 text-xs font-medium ${
                workspace === "enterprise" ? "bg-foreground text-background" : "bg-background"
              }`}
            >
              Enterprise RAG
            </button>
          </div>
        </div>

        <div className="flex border rounded overflow-hidden">
          <button
            type="button"
            onClick={() => {
              setMode("signin")
              setError("")
              setNotice("")
            }}
            className={`flex-1 py-2 text-sm font-medium ${
              mode === "signin" ? "bg-primary text-primary-foreground" : "bg-background"
            }`}
          >
            Sign in
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("signup")
              setError("")
              setNotice("")
            }}
            className={`flex-1 py-2 text-sm font-medium ${
              mode === "signup" ? "bg-primary text-primary-foreground" : "bg-background"
            }`}
          >
            Sign Up
          </button>
        </div>

        <h1 className="text-2xl font-semibold">
          {mode === "signin"
            ? workspace === "enterprise"
              ? "Sign in to Enterprise RAG"
              : "Sign in to Personal RAG"
            : mode === "forgot"
              ? "Reset your password"
              : workspace === "enterprise"
                ? "Sign up for Enterprise RAG"
                : "Sign up for Personal RAG"}
        </h1>

        <label className="block">
          Email
          <input
            className="block w-full border rounded p-2"
            name="email"
            type="email"
            autoComplete="email"
            required
          />
        </label>

        {mode !== "forgot" && (
          <label className="block">
            Password
            <input
              className="block w-full border rounded p-2"
              name="password"
              type="password"
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              minLength={6}
              required
            />
          </label>
        )}

        {mode === "signin" && (
          <div className="text-right">
            <button
              type="button"
              onClick={() => {
                setMode("forgot")
                setError("")
                setNotice("")
              }}
              className="text-sm underline text-muted-foreground hover:text-foreground"
            >
              Forgot password?
            </button>
          </div>
        )}

        {mode === "signup" && (
          <div className="space-y-3">
            {workspace === "enterprise" ? (
              <>
                <label className="block space-y-1">
                  <span className="text-sm font-medium">Department</span>
                  <select
                    className="block w-full border rounded p-2 bg-background text-sm"
                    name="department"
                    defaultValue=""
                    required={workspace === "enterprise"}
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
                <label className="flex items-start gap-2.5 rounded-md border p-3 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    name="demoJiraAccess"
                    checked={demoJiraAccess}
                    onChange={(event) => setDemoJiraAccess(event.target.checked)}
                    className="mt-0.5 size-4 rounded border"
                  />
                  <span className="space-y-1">
                    <span className="block font-medium">Enable Jira Ticket Creation</span>
                    <span className="block text-xs text-muted-foreground">
                      Allow creation of Jira tickets through the confirmation workflow.
                    </span>
                  </span>
                </label>
                <p className="text-xs text-muted-foreground">
                  Selecting a department automatically grants active Employee membership in DeccanBridge Software with access to Company-wide Standard and your department&apos;s Standard documents.
                </p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                Create a Personal RAG account for private document workspaces and isolated vector search.
              </p>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
            {notice}
          </p>
        )}

        <button disabled={pending} className="border rounded px-4 py-2">
          {mode === "signin"
            ? pending
              ? "Signing in…"
              : "Sign in"
            : mode === "forgot"
              ? pending
                ? "Sending reset link…"
                : "Send reset link"
              : pending
                ? "Signing up…"
                : "Sign Up"}
        </button>

        {mode === "forgot" && (
          <div>
            <button
              type="button"
              onClick={() => {
                setMode("signin")
                setError("")
                setNotice("")
              }}
              className="text-sm underline text-muted-foreground hover:text-foreground"
            >
              Back to Sign in
            </button>
          </div>
        )}
      </form>
    </main>
  )
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen flex items-center justify-center p-6">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </main>
      }
    >
      <LoginForm />
    </Suspense>
  )
}
