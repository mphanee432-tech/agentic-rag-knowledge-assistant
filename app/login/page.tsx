"use client"
import { useState, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import { createBrowserClient } from "@/lib/supabase/client"
export default function LoginPage() {
  const router = useRouter()
  const [error, setError] = useState("")
  const [pending, setPending] = useState(false)
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError("")
    const form = new FormData(event.currentTarget)
    try {
      const { error } = await createBrowserClient().auth.signInWithPassword({
        email: String(form.get("email")), password: String(form.get("password")),
      })
      if (error) { setError("Unable to sign in. Check your email and password."); return }
      router.replace("/")
      router.refresh()
    } catch { setError("Sign-in is unavailable. Please retry.") }
    finally { setPending(false) }
  }
  return <main className="min-h-screen flex items-center justify-center p-6">
    <form onSubmit={signIn} className="w-full max-w-sm space-y-4">
      <h1 className="text-2xl font-semibold">Sign in to Knowledge Assistant</h1>
      <label className="block">Email<input className="block w-full border rounded p-2" name="email" type="email" autoComplete="email" required /></label>
      <label className="block">Password<input className="block w-full border rounded p-2" name="password" type="password" autoComplete="current-password" required /></label>
      {error && <p role="alert">{error}</p>}
      <button disabled={pending} className="border rounded px-4 py-2">{pending ? "Signing in…" : "Sign in"}</button>
    </form>
  </main>
}

