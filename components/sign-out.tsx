"use client"

import { useRouter } from "next/navigation"
import { useEffect } from "react"
import { signOut } from "@/app/actions/auth"
import { Button } from "@/components/ui/button"
import { useChatStore } from "@/lib/store/chat-store"
import { createBrowserClient } from "@/lib/supabase/client"

export function ChatSessionBoundary() {
  const router = useRouter()
  useEffect(() => {
    const invalidate = () => {
      useChatStore.getState().setAccount(null)
      router.refresh()
    }
    const { data: { subscription } } = createBrowserClient().auth.onAuthStateChange((_event, session) => {
      const account = useChatStore.getState().accountId
      if (account && account !== session?.user.id) invalidate()
    })
    const logout = new BroadcastChannel("copilot-sign-out")
    logout.onmessage = invalidate
    return () => { subscription.unsubscribe(); logout.close() }
  }, [router])
  return null
}

export function SignOut() {
  const router = useRouter()
  return <form action={async () => {
    useChatStore.getState().setAccount(null)
    await signOut()
    const logout = new BroadcastChannel("copilot-sign-out")
    logout.postMessage(null)
    logout.close()
    router.replace("/login")
    router.refresh()
  }}><Button variant="ghost" type="submit">Sign out</Button></form>
}
