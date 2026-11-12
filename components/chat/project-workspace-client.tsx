"use client"

import * as React from "react"
import { sendChat } from "@/lib/send-chat"
import { Sidebar } from "@/components/chat/sidebar"
import { ChatContainer } from "@/components/chat/chat-container"
import { useChatStore } from "@/lib/store/chat-store"

interface ProjectWorkspaceClientProps {
  projectId: string
  projectName?: string | null
  enterprise?: boolean
}

export function ProjectWorkspaceClient({
  projectId,
  projectName,
  enterprise,
}: ProjectWorkspaceClientProps) {
  const activeProjectId = useChatStore(state => state.activeProjectId)
  const setActiveProject = useChatStore(state => state.setActiveProject)

  // Sidebar owns workspace loading once the route's project is active.
  React.useEffect(() => {
    if (projectId && activeProjectId !== projectId) setActiveProject(projectId)
  }, [projectId, activeProjectId, setActiveProject])

  const handleSelectSuggestion = (query: string) => sendChat(query, projectId)

  if (activeProjectId !== projectId) return <main aria-busy="true" className="p-6">Loading workspace…</main>

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground font-sans">
      {/* Left Sidebar: Document Quota & Repository Sources with strict tenant id */}
      {!enterprise && <Sidebar
        onSelectSuggestion={handleSelectSuggestion}
        projectId={projectId}
        projectName={projectName}
      />}

      {/* Main Research Copilot Chat Interface with strict tenant id */}
      <ChatContainer
        projectId={projectId}
        projectName={projectName}
        enterprise={enterprise}
      />
    </div>
  )
}
