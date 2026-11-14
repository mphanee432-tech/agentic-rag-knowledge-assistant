"use client"

import * as React from "react"
import { sendChat } from "@/lib/send-chat"
import { Sidebar } from "@/components/chat/sidebar"
import { ChatContainer } from "@/components/chat/chat-container"
import { useChatStore } from "@/lib/store/chat-store"

type ProjectWorkspaceClientProps = {
  userId: string
} & (
  | { projectId: string; projectName?: string | null; organizationId?: never; canUploadPolicy?: never }
  | { organizationId: string; canUploadPolicy: boolean; projectId?: never; projectName?: never }
)

export function ProjectWorkspaceClient({
  userId,
  projectId,
  projectName,
  organizationId,
  canUploadPolicy,
}: ProjectWorkspaceClientProps) {
  const accountId = useChatStore(state => state.accountId)
  const activeProjectId = useChatStore(state => state.activeProjectId)
  const chatScope = projectId ?? `organization:${organizationId}`

  // Sidebar owns workspace loading once the route's project is active.
  React.useEffect(() => {
    useChatStore.getState().setAccount(userId)
    if (useChatStore.getState().activeProjectId !== chatScope) useChatStore.getState().setActiveProject(chatScope)
  }, [userId, chatScope])

  const handleSelectSuggestion = (query: string) => sendChat(query, projectId)

  if (accountId !== userId || activeProjectId !== chatScope) return <main aria-busy="true" className="p-6">Loading chat…</main>

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground font-sans">
      {/* Left Sidebar: Document Quota & Repository Sources with strict tenant id */}
      {projectId && <Sidebar
        onSelectSuggestion={handleSelectSuggestion}
        projectId={projectId}
        projectName={projectName}
      />}

      {/* Main Research Copilot Chat Interface with strict tenant id */}
      <ChatContainer
        projectId={projectId}
        projectName={projectName}
        organizationId={organizationId}
        canUploadPolicy={canUploadPolicy}
      />
    </div>
  )
}
