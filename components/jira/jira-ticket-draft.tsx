"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DEFAULT_JIRA_PROJECT_ID,
  JIRA_DESCRIPTION_MAX,
  JIRA_SUMMARY_MAX,
  type JiraFieldOptionsResponse,
} from "@/lib/jira-ticket"

export interface JiraTicketDraftState {
  summary: string
  description: string
  projectId: string
  issueTypeId: string
  assigneeId: string
  priorityId: string
}

export function useJiraTicketDraft(options: {
  organizationId?: string
  onTicketCreated?: (ticketKey: string) => void
}) {
  const { organizationId, onTicketCreated } = options
  const [jiraDraft, setJiraDraft] = React.useState<JiraTicketDraftState | null>(null)
  const [jiraOptions, setJiraOptions] = React.useState<JiraFieldOptionsResponse | null>(null)
  const [isLoadingJiraOptions, setIsLoadingJiraOptions] = React.useState(false)
  const [jiraOptionsError, setJiraOptionsError] = React.useState("")
  const [jiraError, setJiraError] = React.useState("")
  const [isCreatingTicket, setIsCreatingTicket] = React.useState(false)
  const creatingTicket = React.useRef(false)
  const jiraOptionsRequestId = React.useRef(0)

  const loadJiraOptions = React.useCallback(
    async (targetProjectId: string) => {
      const requestId = ++jiraOptionsRequestId.current
      setIsLoadingJiraOptions(true)
      setJiraOptionsError("")

      try {
        const body: Record<string, string> = { projectId: targetProjectId }
        if (organizationId) body.organizationId = organizationId

        const response = await fetch("/api/jira/options", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        const payload = (await response.json().catch(() => null)) as
          | (JiraFieldOptionsResponse & { error?: string })
          | null
        if (jiraOptionsRequestId.current !== requestId) return

        if (
          !response.ok ||
          !payload ||
          !Array.isArray(payload.projects) ||
          !Array.isArray(payload.issueTypes) ||
          !Array.isArray(payload.assignees) ||
          !Array.isArray(payload.priorities)
        ) {
          setJiraOptions(null)
          setJiraOptionsError(
            typeof payload?.error === "string"
              ? payload.error
              : "Unable to load Jira options. Please retry.",
          )
          return
        }

        setJiraOptions(payload)
        setJiraDraft((current) => {
          if (!current) return current
          const nextProjectId = payload.projects.some((p) => p.id === targetProjectId)
            ? targetProjectId
            : payload.projects[0]?.id ?? ""
          const nextIssueTypeId = payload.issueTypes.some((t) => t.id === current.issueTypeId)
            ? current.issueTypeId
            : payload.issueTypes.find((t) => t.name.toLowerCase() === "task")?.id ??
              payload.issueTypes[0]?.id ??
              ""
          const nextAssigneeId = payload.assignees.some((a) => a.id === current.assigneeId)
            ? current.assigneeId
            : payload.assignees[0]?.id ?? ""
          const nextPriorityId = payload.priorities.some((p) => p.id === current.priorityId)
            ? current.priorityId
            : payload.priorities.find((p) => p.name.toLowerCase() === "medium")?.id ??
              payload.priorities.find((p) => p.isDefault)?.id ??
              payload.priorities[0]?.id ??
              ""
          return {
            ...current,
            projectId: nextProjectId,
            issueTypeId: nextIssueTypeId,
            assigneeId: nextAssigneeId,
            priorityId: nextPriorityId,
          }
        })
      } catch {
        if (jiraOptionsRequestId.current !== requestId) return
        setJiraOptions(null)
        setJiraOptionsError("Unable to load Jira options. Please retry.")
      } finally {
        if (jiraOptionsRequestId.current === requestId) {
          setIsLoadingJiraOptions(false)
        }
      }
    },
    [organizationId],
  )

  const closeJiraDraft = React.useCallback(() => {
    jiraOptionsRequestId.current += 1
    setJiraDraft(null)
    setJiraOptions(null)
    setJiraOptionsError("")
    setJiraError("")
    setIsLoadingJiraOptions(false)
  }, [])

  const openJiraDraft = React.useCallback(
    (initial?: { summary?: string; description?: string }) => {
      setJiraError("")
      setJiraOptions(null)
      setJiraOptionsError("")
      setJiraDraft({
        summary: initial?.summary ?? "",
        description: initial?.description ?? "",
        projectId: DEFAULT_JIRA_PROJECT_ID,
        issueTypeId: "",
        assigneeId: "",
        priorityId: "",
      })
      void loadJiraOptions(DEFAULT_JIRA_PROJECT_ID)
    },
    [loadJiraOptions],
  )

  const confirmJiraTicket = React.useCallback(async () => {
    if (
      !jiraDraft?.summary.trim() ||
      !jiraDraft.description.trim() ||
      !jiraDraft.projectId ||
      !jiraDraft.issueTypeId ||
      !jiraDraft.assigneeId ||
      !jiraDraft.priorityId ||
      isLoadingJiraOptions ||
      Boolean(jiraOptionsError) ||
      creatingTicket.current
    ) {
      return
    }
    creatingTicket.current = true
    setIsCreatingTicket(true)
    setJiraError("")
    const unconfirmed = "Ticket creation could not be verified. Check Jira before trying again."
    try {
      const payload: Record<string, string> = { ...jiraDraft }
      if (organizationId) payload.organizationId = organizationId

      const response = await fetch("/api/jira/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const result = await response.json().catch(() => null)
      if (!response.ok || typeof result?.ticketKey !== "string") {
        setJiraError(typeof result?.error === "string" ? result.error : unconfirmed)
        return
      }
      onTicketCreated?.(result.ticketKey)
      closeJiraDraft()
    } catch {
      setJiraError(unconfirmed)
    } finally {
      creatingTicket.current = false
      setIsCreatingTicket(false)
    }
  }, [closeJiraDraft, isLoadingJiraOptions, jiraDraft, jiraOptionsError, onTicketCreated, organizationId])

  return {
    jiraDraft,
    setJiraDraft,
    jiraOptions,
    isLoadingJiraOptions,
    jiraOptionsError,
    jiraError,
    isCreatingTicket,
    loadJiraOptions,
    openJiraDraft,
    closeJiraDraft,
    confirmJiraTicket,
  }
}

interface JiraTicketDraftFormProps {
  jiraDraft: JiraTicketDraftState
  setJiraDraft: React.Dispatch<React.SetStateAction<JiraTicketDraftState | null>>
  jiraOptions: JiraFieldOptionsResponse | null
  isLoadingJiraOptions: boolean
  jiraOptionsError: string
  jiraError: string
  isCreatingTicket: boolean
  onLoadOptions: (projectId: string) => void
  onConfirm: () => void
  onCancel: () => void
  className?: string
}

export function JiraTicketDraftForm({
  jiraDraft,
  setJiraDraft,
  jiraOptions,
  isLoadingJiraOptions,
  jiraOptionsError,
  jiraError,
  isCreatingTicket,
  onLoadOptions,
  onConfirm,
  onCancel,
  className = "max-w-3xl w-full mx-auto space-y-3 rounded-xl border p-4",
}: JiraTicketDraftFormProps) {
  return (
    <section aria-label="Jira ticket draft" className={className}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Jira ticket draft</h2>
        {isLoadingJiraOptions && (
          <span className="text-xs text-muted-foreground">Loading Jira options…</span>
        )}
      </div>
      {jiraOptionsError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          <span>{jiraOptionsError}</span>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={isLoadingJiraOptions || isCreatingTicket}
            onClick={() => onLoadOptions(jiraDraft.projectId)}
          >
            Retry
          </Button>
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block space-y-1 text-sm">
          <span>Project</span>
          <select
            className="w-full rounded-md border bg-background p-2 text-sm focus-visible:outline-primary"
            value={jiraDraft.projectId}
            onChange={(event) => {
              const nextProjectId = event.target.value
              setJiraDraft({
                ...jiraDraft,
                projectId: nextProjectId,
                issueTypeId: "",
                assigneeId: "",
                priorityId: "",
              })
              onLoadOptions(nextProjectId)
            }}
            disabled={isCreatingTicket || isLoadingJiraOptions || !jiraOptions?.projects.length}
            required
          >
            {(jiraOptions?.projects ?? []).map((option) => (
              <option key={option.id} value={option.id}>
                {option.name} ({option.key})
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1 text-sm">
          <span>Issue Type</span>
          <select
            className="w-full rounded-md border bg-background p-2 text-sm focus-visible:outline-primary"
            value={jiraDraft.issueTypeId}
            onChange={(event) => setJiraDraft({ ...jiraDraft, issueTypeId: event.target.value })}
            disabled={isCreatingTicket || isLoadingJiraOptions || !jiraOptions?.issueTypes.length}
            required
          >
            {(jiraOptions?.issueTypes ?? []).map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1 text-sm">
          <span>Assignee</span>
          <select
            className="w-full rounded-md border bg-background p-2 text-sm focus-visible:outline-primary"
            value={jiraDraft.assigneeId}
            onChange={(event) => setJiraDraft({ ...jiraDraft, assigneeId: event.target.value })}
            disabled={isCreatingTicket || isLoadingJiraOptions || !jiraOptions?.assignees.length}
            required
          >
            {(jiraOptions?.assignees ?? []).map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1 text-sm">
          <span>Priority</span>
          <select
            className="w-full rounded-md border bg-background p-2 text-sm focus-visible:outline-primary"
            value={jiraDraft.priorityId}
            onChange={(event) => setJiraDraft({ ...jiraDraft, priorityId: event.target.value })}
            disabled={isCreatingTicket || isLoadingJiraOptions || !jiraOptions?.priorities.length}
            required
          >
            {(jiraOptions?.priorities ?? []).map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block space-y-1 text-sm">
        <span>Summary</span>
        <Input
          value={jiraDraft.summary}
          onChange={(event) => setJiraDraft({ ...jiraDraft, summary: event.target.value })}
          maxLength={JIRA_SUMMARY_MAX}
          disabled={isCreatingTicket}
        />
      </label>
      <label className="block space-y-1 text-sm">
        <span>Description</span>
        <textarea
          className="w-full rounded-md border bg-transparent p-2 text-sm focus-visible:outline-primary"
          value={jiraDraft.description}
          onChange={(event) => setJiraDraft({ ...jiraDraft, description: event.target.value })}
          maxLength={JIRA_DESCRIPTION_MAX}
          disabled={isCreatingTicket}
          rows={4}
        />
      </label>
      {jiraError && (
        <p role="alert" className="text-sm text-destructive">
          {jiraError}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          onClick={onConfirm}
          disabled={
            isCreatingTicket ||
            isLoadingJiraOptions ||
            Boolean(jiraOptionsError) ||
            !jiraDraft.projectId ||
            !jiraDraft.issueTypeId ||
            !jiraDraft.assigneeId ||
            !jiraDraft.priorityId ||
            !jiraDraft.summary.trim() ||
            !jiraDraft.description.trim()
          }
        >
          {isCreatingTicket ? "Creating ticket…" : "Confirm"}
        </Button>
        <Button type="button" variant="outline" disabled={isCreatingTicket} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  )
}

export function DemoJiraCard() {
  const [createdTicketKey, setCreatedTicketKey] = React.useState<string | null>(null)
  const {
    jiraDraft,
    setJiraDraft,
    jiraOptions,
    isLoadingJiraOptions,
    jiraOptionsError,
    jiraError,
    isCreatingTicket,
    loadJiraOptions,
    openJiraDraft,
    closeJiraDraft,
    confirmJiraTicket,
  } = useJiraTicketDraft({
    onTicketCreated: (ticketKey) => setCreatedTicketKey(ticketKey),
  })

  return (
    <section aria-label="Demo Jira ticket creation" className="mb-8 rounded-xl border border-border bg-card p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Demo Jira Integration</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Create a Jira ticket in the approved demo projects (ECD and KAN) using live Jira options.
          </p>
        </div>
        {!jiraDraft && (
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setCreatedTicketKey(null)
              openJiraDraft()
            }}
          >
            Create Jira Ticket
          </Button>
        )}
      </div>

      {createdTicketKey && (
        <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
          Created Jira ticket <strong>{createdTicketKey}</strong>.
        </p>
      )}

      {jiraDraft && (
        <JiraTicketDraftForm
          jiraDraft={jiraDraft}
          setJiraDraft={setJiraDraft}
          jiraOptions={jiraOptions}
          isLoadingJiraOptions={isLoadingJiraOptions}
          jiraOptionsError={jiraOptionsError}
          jiraError={jiraError}
          isCreatingTicket={isCreatingTicket}
          onLoadOptions={(projectId) => void loadJiraOptions(projectId)}
          onConfirm={() => void confirmJiraTicket()}
          onCancel={closeJiraDraft}
          className="space-y-3 rounded-xl border p-4 bg-background"
        />
      )}
    </section>
  )
}

