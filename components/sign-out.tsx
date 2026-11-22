"use client"

import { useRouter } from "next/navigation"
import { useEffect } from "react"
import { signOut } from "@/app/actions/auth"
import { Button } from "@/components/ui/button"
import { clearAllLastJiraTicketKeys } from "@/lib/jira-ticket"
import { useChatStore } from "@/lib/store/chat-store"
import { createBrowserClient } from "@/lib/supabase/client"
import { isDualProjectConfigured, type WorkspaceScope } from "@/lib/supabase/config"

function getActivePageWorkspace(): WorkspaceScope | null {
  if (typeof window === "undefined") return null
  if (window.location.pathname.startsWith("/login") || window.location.pathname.startsWith("/reset-password")) {
    return null
  }
  return new URLSearchParams(window.location.search).get("tab") === "enterprise"
    ? "enterprise"
    : "personal"
}

export function ChatSessionBoundary() {
  const router = useRouter()
  useEffect(() => {
    const invalidate = () => {
      clearAllLastJiraTicketKeys()
      useChatStore.getState().setAccount(null)
      router.refresh()
    }
    const scopes: WorkspaceScope[] = isDualProjectConfigured()
      ? ["personal", "enterprise"]
      : ["personal"]
    const subscriptions = scopes.map((scope) => {
      const { data: { subscription } } = createBrowserClient(scope).auth.onAuthStateChange((_event, session) => {
        const activeWorkspace = getActivePageWorkspace()
        if (activeWorkspace && activeWorkspace !== scope && scopes.length > 1) return
        const account = useChatStore.getState().accountId
        if (account && account !== session?.user.id) invalidate()
      })
      return subscription
    })
    const logout = new BroadcastChannel("copilot-sign-out")
    logout.onmessage = (event: MessageEvent<{ workspace?: WorkspaceScope } | null>) => {
      const targetWorkspace = event.data?.workspace
      const activeWorkspace = getActivePageWorkspace()
      if (!targetWorkspace || !activeWorkspace || targetWorkspace === activeWorkspace) {
        invalidate()
      }
    }
    return () => {
      subscriptions.forEach((subscription) => subscription.unsubscribe())
      logout.close()
    }
  }, [router])
  return null
}

export function SignOut({ workspace = "personal" }: { workspace?: WorkspaceScope }) {
  const router = useRouter()
  return <form action={async () => {
    clearAllLastJiraTicketKeys()
    useChatStore.getState().setAccount(null)
    await signOut(workspace)
    await createBrowserClient(workspace).auth.signOut({ scope: "local" }).catch(() => null)
    const logout = new BroadcastChannel("copilot-sign-out")
    logout.postMessage({ workspace })
    logout.close()
    router.replace(workspace === "enterprise" ? "/login?workspace=enterprise" : "/login?workspace=personal")
    router.refresh()
  }}><Button variant="ghost" type="submit">Sign out</Button></form>
}
