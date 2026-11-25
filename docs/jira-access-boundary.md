# Enterprise Jira Access Boundary (Revised)

## Scope

This document records the revised Jira read-only status access boundary for **Enterprise Employee Knowledge Copilot v2** on branch `fix/final-agentic-reliability`. Case `E23` in [`evals/agentic_eval_40.jsonl`](../evals/agentic_eval_40.jsonl) has been reconciled to reflect both permitted `ECD` and `KAN` projects while rejecting non-allowlisted project keys (such as `ABC-1` and `SEC-1`). All other 39 golden cases (`P01`–`P15`, `E01`–`E22`, `E24`, `E25`), scoring thresholds, and archived historical evaluation baselines remain unchanged.

## Single Source of Truth

Permitted Jira projects are defined once in [`ALLOWED_JIRA_PROJECTS`](../lib/jira-ticket.ts):

- `ECD` (`id: "10001"`, `Employee Copilot Demo`)
- `KAN` (`id: "10000"`, `Product Team`)

From `ALLOWED_JIRA_PROJECTS`, [`lib/jira-ticket.ts`](../lib/jira-ticket.ts) derives:

- `ALLOWED_JIRA_PROJECT_KEYS` (`["ECD", "KAN"]`)
- `ALLOWED_JIRA_PROJECT_KEYS_LABEL` (`"ECD and KAN"`)
- `JIRA_ALLOWED_ISSUE_KEY_PATTERN` (`^(?:ECD|KAN)-[1-9]\d*$`)
- `JIRA_STATUS_CLARIFICATION_PROMPT`: `"Please share the Jira ticket ID (for example, ECD-6 or KAN-1) so I can check its status."`

Arbitrary Jira project keys outside `ALLOWED_JIRA_PROJECTS` (for example `ABC-1`, `ENG-12`, `OPS-99`, `SEC-1`) remain rejected with HTTP `403`:

```text
Only ECD and KAN project Jira tickets are accessible in this demo.
```

## Authorization & Runtime Controls

1. **Read-only status lookup (`POST /api/jira/status` and `/api/chat` -> `jira_status`)**
   - Requires an authenticated Enterprise Supabase session (`requireUser(req, "enterprise")`).
   - Enforces active organization membership via the `enterprise_copilot_context` RPC (`getEnterpriseCopilotContext`). Non-members, inactive users, and cross-organization requests are rejected with HTTP `403`.
   - Enforces issue key syntax (`JIRA_ISSUE_KEY_PATTERN`, `400` on malformed keys) and project allowlist (`JIRA_ALLOWED_ISSUE_KEY_PATTERN`, `403` on non-allowlisted keys) in [`lookupEnterpriseJiraStatus`](../lib/jira-status.ts) before invoking `ACTIVEPIECES_JIRA_STATUS_WEBHOOK_URL`.
   - Validates the upstream Activepieces response envelope (`success === true`, exact `ticketKey` echo match, non-empty `status`, string `summary`).
   - Follow-up context (`extractLatestJiraTicketKeyFromMessages`, `readLastJiraTicketKey`, `writeLastJiraTicketKey`) supports `ECD-*` and `KAN-*` keys so keyless follow-ups such as `"What is the status of my ticket?"` resolve to a previously referenced `ECD` or `KAN` ticket when present.

2. **Jira ticket creation & project options (`/api/jira/options`, `/api/jira/create`)**
   - Unchanged. Continues to require explicit `demo_jira_access` opt-in (`enabled = true`), active org membership, and `ALLOWED_JIRA_PROJECTS` project selection.

3. **External Jira / Document RLS separation**
   - Document-level PostgreSQL RLS does not govern external Jira issues; project scoping is enforced server-side via `ALLOWED_JIRA_PROJECTS` plus active organization membership.

## Live Activepieces Status Workflow Verification

Verified read-only status lookups against the configured `ACTIVEPIECES_JIRA_STATUS_WEBHOOK_URL/sync` endpoint:

- `ECD-6` -> HTTP `200` (`status: "In Progress"`, `summary: "VPN disconnects firs ticket"`)
- `KAN-1` -> HTTP `200` (`status: "Idea"`, `summary: "repeated VPN disconnections. The VPN disconnects every 30 minutes and interrupts employees'"`)

All active Enterprise employees with `enterprise_copilot_context` membership can read `ECD-*` and `KAN-*` ticket statuses through this workflow.
