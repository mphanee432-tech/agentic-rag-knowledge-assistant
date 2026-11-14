"use client"
import { useState, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import { createBrowserClient } from "@/lib/supabase/client"
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

function getPendingDepartmentCookie(userId: string) {
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

export default function LoginPage() {
  const router = useRouter()
  const [mode, setMode] = useState<"signin" | "signup" | "forgot">("signin")
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
    const supabase = createBrowserClient()

    try {
      if (mode === "forgot") {
        if (!email) {
          setError("Please enter your email address.")
          return
        }
        const redirectTo = `${window.location.origin}/reset-password`
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
        const pendingDepartment = getPendingDepartmentCookie(data.session.user.id)
        if (pendingDepartment) {
          await completeDemoOnboarding(pendingDepartment)
        }
        useChatStore.getState().setAccount(null)
        router.replace("/")
        router.refresh()
        return
      }

      const selectedDepartment = String(form.get("department") ?? "").trim()
      if (!isDemoDepartment(selectedDepartment)) {
        setError("Please select a valid demo department.")
        return
      }

      const { data, error: signUpError } = await supabase.auth.signUp({ email, password })

      if (signUpError?.code === "user_already_exists" || signUpError?.code === "email_exists" ||
        /already registered|already exists/i.test(signUpError?.message ?? "") ||
        data.user?.identities?.length === 0) {
        setError("An account with this email already exists. Please sign in.")
        return
      }
      if (signUpError) {
        setError(signUpError.message || "Unable to sign up. Check your email and password.")
        return
      }
      if (!data.session) {
        setError("Immediate signup is unavailable. Please contact the demo administrator.")
        return
      }

      setPendingDepartmentCookie(data.session.user.id, selectedDepartment)
      setMode("signin")
      await completeDemoOnboarding(selectedDepartment)
      useChatStore.getState().setAccount(null)
      router.replace("/")
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
            ? "Sign in to Knowledge Assistant"
            : mode === "forgot"
              ? "Reset your password"
              : "Sign up for Knowledge Assistant"}
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
          <div className="space-y-1.5">
            <label className="block">
              Demo Department
              <select
                className="block w-full border rounded p-2 bg-background"
                name="department"
                defaultValue=""
                required
              >
                <option value="" disabled>Select a department</option>
                {DEMO_DEPARTMENTS.map((dept) => (
                  <option key={dept} value={dept}>
                    {dept}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-xs text-muted-foreground">
              Public demo signup assigns standard Employee access for DeccanBridge Software in your selected department.
            </p>
          </div>
        )}

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {notice && <p role="status" className="text-sm text-foreground">{notice}</p>}

        <div className="flex items-center gap-3">
          <button disabled={pending} className="border rounded px-4 py-2">
            {mode === "signin"
              ? pending
                ? "Signing in…"
                : "Sign in"
              : mode === "forgot"
                ? pending
                  ? "Sending…"
                  : "Send reset link"
                : pending
                  ? "Signing up…"
                  : "Sign Up"}
          </button>
          {mode === "forgot" && (
            <button
              type="button"
              onClick={() => {
                setMode("signin")
                setError("")
                setNotice("")
              }}
              className="text-sm underline text-muted-foreground hover:text-foreground"
            >
              Back to sign in
            </button>
          )}
        </div>
      </form>
    </main>
  )
}
