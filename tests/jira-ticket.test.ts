import assert from "node:assert/strict"
import test from "node:test"
import { POST } from "../app/api/jira/create/route"
import { POST as POST_OPTIONS } from "../app/api/jira/options/route"
import { POST as POST_STATUS } from "../app/api/jira/status/route"
import {
  DEFAULT_JIRA_PROJECT_ID,
  draftJiraTicket,
  extractJiraStatusIssueKey,
} from "../lib/jira-ticket"

const DEFAULT_ISSUE_TYPE_ID = "10011"
const DEFAULT_ASSIGNEE_ID = "712020:44a89047-24f6-45c5-8388-74b575ee1006"
const DEFAULT_PRIORITY_ID = "3"

function makeLiveOptionsPayload(projectId = "10001") {
  const isKan = projectId === "10000"
  return {
    projects: [
      { id: "10001", key: "ECD", name: "Employee Copilot Demo", self: "https://jira.invalid/p/10001" },
      { id: "10000", key: "KAN", name: "Product Team", self: "https://jira.invalid/p/10000" },
      { id: "10999", key: "SEC", name: "Unauthorized Secret Project" },
    ],
    issueTypes: isKan
      ? [
          { id: "10001", name: "Epic", subtask: false, hierarchyLevel: 1 },
          { id: "10002", name: "Subtask", subtask: true, hierarchyLevel: -1 },
          { id: "10003", name: "Feature", subtask: false, hierarchyLevel: 0 },
          { id: "10004", name: "Task", subtask: false, hierarchyLevel: 0 },
          { id: "10005", name: "Story", subtask: false, hierarchyLevel: 0 },
          { id: "10006", name: "Bug", subtask: false, hierarchyLevel: 0 },
        ]
      : [
          { id: "10007", name: "Subtask", subtask: true, hierarchyLevel: -1 },
          { id: "10008", name: "Epic", subtask: false, hierarchyLevel: 1 },
          { id: "10009", name: "Story", subtask: false, hierarchyLevel: 0 },
          { id: "10010", name: "Bug", subtask: false, hierarchyLevel: 0 },
          { id: "10011", name: "Task", subtask: false, hierarchyLevel: 0 },
        ],
    assignees: [
      {
        accountId: DEFAULT_ASSIGNEE_ID,
        displayName: "phani9119",
        active: true,
        emailAddress: "private@example.invalid",
      },
      {
        accountId: "5dd32731b3a9c80fc0a3024b",
        displayName: "Phaneendra Sai",
        active: true,
        emailAddress: "private2@example.invalid",
      },
      {
        accountId: "inactive-user",
        displayName: "Inactive User",
        active: false,
      },
    ],
    priorities: [
      { id: "1", name: "Highest", isDefault: false },
      { id: "2", name: "High", isDefault: false },
      { id: "3", name: "Medium", isDefault: false },
      { id: "4", name: "Low", isDefault: false },
      { id: "5", name: "Lowest", isDefault: false },
    ],
  }
}

test("drafts explicit Jira requests and leaves ordinary questions on the chat path", () => {
  assert.deepEqual(draftJiraTicket("Could you please create a Jira ticket for: VPN disconnects\nAfter waking from sleep."), {
    summary: "VPN disconnects",
    description: "VPN disconnects\nAfter waking from sleep.",
  })
  assert.deepEqual(draftJiraTicket("File an issue in Jira."), { summary: "", description: "" })
  assert.equal(draftJiraTicket("How do I create a Jira ticket?"), null)
  assert.equal(draftJiraTicket("What is the VPN policy?"), null)
})

test("Jira route requires an active employee, validates live options, and verifies synchronous webhook result", async t => {
  const organizationId = "11111111-1111-4111-8111-111111111111"
  const details = {
    organizationId,
    summary: "  VPN disconnects ",
    description: " Edited description\nSecond line. ",
    projectId: DEFAULT_JIRA_PROJECT_ID,
    issueTypeId: DEFAULT_ISSUE_TYPE_ID,
    assigneeId: DEFAULT_ASSIGNEE_ID,
    priorityId: DEFAULT_PRIORITY_ID,
  }
  const env = {
    NEXT_PUBLIC_SUPABASE_URL: "https://supabase.invalid",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
    ACTIVEPIECES_JIRA_WEBHOOK_URL: "https://activepieces.invalid/api/v1/webhooks/example/sync/",
    ACTIVEPIECES_JIRA_OPTIONS_WEBHOOK_URL: "https://activepieces.invalid/api/v1/webhooks/options/sync/",
  }
  const previous = Object.entries(env).map(([key]) => [key, process.env[key]] as const)
  Object.assign(process.env, env)
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  let webhookCalls = 0
  let optionsCalls = 0
  let webhookResponse = () => Response.json({ success: true, ticketKey: "ECD-3", ignored: "private" })
  let optionsResponse = (projectId: string) => Response.json(makeLiveOptionsPayload(projectId))
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const token = new Headers(init?.headers).get("authorization")
    if (url.pathname === "/auth/v1/user") {
      return token === "Bearer expired"
        ? Response.json({ message: "Invalid session" }, { status: 401 })
        : Response.json({ id: "employee", role: "authenticated" })
    }
    if (url.pathname === "/rest/v1/rpc/enterprise_copilot_context") {
      assert.deepEqual(JSON.parse(String(init?.body)), { target_organization_id: organizationId })
      return Response.json(token === "Bearer inactive" ? [] : [{ organization_id: organizationId }])
    }
    if (url.href === "https://activepieces.invalid/api/v1/webhooks/options/sync") {
      optionsCalls++
      const body = JSON.parse(String(init?.body)) as { projectId: string; projectKey: string }
      return optionsResponse(body.projectId)
    }
    webhookCalls++
    assert.equal(url.href, "https://activepieces.invalid/api/v1/webhooks/example/sync")
    assert.equal(init?.method, "POST")
    assert.equal(token, null)
    const sent = JSON.parse(String(init?.body)) as Record<string, string>
    assert.equal(sent.summary, "VPN disconnects")
    assert.equal(sent.description, "Edited description\nSecond line.")
    return webhookResponse()
  })

  const create = (body: unknown, token = "employee", contentType = "application/json") => POST(new Request(
    "https://app.invalid/api/jira/create",
    { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType }, body: JSON.stringify(body) },
  ))

  assert.equal((await create(details, "expired")).status, 401)
  assert.equal((await create(details, "inactive")).status, 403)
  assert.equal((await create(details, "employee", "text/plain")).status, 415)
  assert.equal((await create({ ...details, projectId: "99999" })).status, 403)
  for (const invalid of [
    null, { ...details, organizationId: "invalid" }, { ...details, summary: " " },
    { ...details, summary: "X".repeat(256) }, { ...details, summary: "One\nTwo" },
    { ...details, description: "" }, { ...details, description: 123 }, { ...details, description: "X".repeat(10_001) },
    { ...details, projectId: "" },
  ]) assert.equal((await create(invalid)).status, 400)
  assert.equal(optionsCalls, 0)
  assert.equal(webhookCalls, 0)

  // Invalid issueType (Subtask 10007, Epic 10008, KAN Task 10004 on ECD), assignee, priority rejected before creation webhook
  for (const invalidSelection of [
    { ...details, issueTypeId: "" },
    { ...details, issueTypeId: "10007" },
    { ...details, issueTypeId: "10008" },
    { ...details, issueTypeId: "10004" },
    { ...details, issueTypeId: 10011 },
    { ...details, assigneeId: "" },
    { ...details, assigneeId: "inactive-user" },
    { ...details, priorityId: "" },
    { ...details, priorityId: "99" },
  ]) {
    assert.equal((await create(invalidSelection)).status, 400)
  }
  assert.equal(webhookCalls, 0)

  // Failed options fetch prevents ticket creation
  optionsResponse = () => Response.json({ error: "broken" }, { status: 500 })
  assert.equal((await create(details)).status, 502)
  assert.equal(webhookCalls, 0)
  optionsResponse = (projectId: string) => Response.json(makeLiveOptionsPayload(projectId))

  delete process.env.ACTIVEPIECES_JIRA_WEBHOOK_URL
  assert.equal((await create(details)).status, 503)
  process.env.ACTIVEPIECES_JIRA_WEBHOOK_URL = env.ACTIVEPIECES_JIRA_WEBHOOK_URL
  assert.equal(webhookCalls, 0)

  const created = await create(details)
  assert.equal(created.status, 200)
  assert.deepEqual(await created.json(), { ticketKey: "ECD-3" })
  assert.equal(webhookCalls, 1)

  const createdKanFeature = await create({
    organizationId,
    summary: "VPN disconnects",
    description: "Edited description\nSecond line.",
    projectId: "10000",
    issueTypeId: "10003",
    assigneeId: "5dd32731b3a9c80fc0a3024b",
    priorityId: "1",
  })
  assert.equal(createdKanFeature.status, 200)
  assert.equal(webhookCalls, 2)

  const withoutExplicitIssueType = {
    organizationId: details.organizationId,
    summary: details.summary,
    description: details.description,
    projectId: details.projectId,
    assigneeId: details.assigneeId,
    priorityId: details.priorityId,
  }
  const createdDefaultIssueType = await create(withoutExplicitIssueType)
  assert.equal(createdDefaultIssueType.status, 200)
  assert.deepEqual(await createdDefaultIssueType.json(), { ticketKey: "ECD-3" })
  assert.equal(webhookCalls, 3)

  for (const failure of [
    () => Response.json({ error: "private details" }, { status: 500 }),
    () => Response.json({ ticketKey: "ECD-3" }),
    () => Response.json({ success: true, ticketKey: "not-a-key" }),
    () => new Response("not JSON"),
    () => { throw new Error("Network failure with private details") },
  ]) {
    webhookResponse = failure
    const response = await create(details)
    assert.equal(response.status, 502)
    assert.deepEqual(await response.json(), {
      error: "Activepieces did not confirm ticket creation. Check Jira before trying again.",
    })
  }
  assert.equal(webhookCalls, 8)
})

test("Jira options route enforces auth, membership, project allowlist, and filters live options", async (t) => {
  const organizationId = "11111111-1111-4111-8111-111111111111"
  const env = {
    NEXT_PUBLIC_SUPABASE_URL: "https://supabase.invalid",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
    ACTIVEPIECES_JIRA_OPTIONS_WEBHOOK_URL: "https://activepieces.invalid/api/v1/webhooks/options/sync/",
  }
  const previous = Object.entries(env).map(([key]) => [key, process.env[key]] as const)
  Object.assign(process.env, env)
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  let optionsCalls = 0
  let webhookResponse: (projectId: string) => Response = (projectId) =>
    Response.json(makeLiveOptionsPayload(projectId))

  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const token = new Headers(init?.headers).get("authorization")
    if (url.pathname === "/auth/v1/user") {
      return token === "Bearer expired"
        ? Response.json({ message: "Invalid session" }, { status: 401 })
        : Response.json({ id: "employee", role: "authenticated" })
    }
    if (url.pathname === "/rest/v1/rpc/enterprise_copilot_context") {
      return Response.json(token === "Bearer inactive" ? [] : [{ organization_id: organizationId }])
    }
    optionsCalls++
    assert.equal(url.href, "https://activepieces.invalid/api/v1/webhooks/options/sync")
    const body = JSON.parse(String(init?.body)) as { projectId: string; projectKey: string }
    assert.equal(body.projectKey, body.projectId === "10000" ? "KAN" : "ECD")
    return webhookResponse(body.projectId)
  })

  const fetchOptions = (body: unknown, token = "employee", contentType = "application/json") =>
    POST_OPTIONS(
      new Request("https://app.invalid/api/jira/options", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType },
        body: JSON.stringify(body),
      }),
    )

  assert.equal((await fetchOptions({ organizationId, projectId: "10001" }, "expired")).status, 401)
  assert.equal((await fetchOptions({ organizationId, projectId: "10001" }, "inactive")).status, 403)
  assert.equal((await fetchOptions({ organizationId, projectId: "10999" })).status, 403)
  assert.equal((await fetchOptions({ organizationId, projectId: "bad" })).status, 400)
  assert.equal(optionsCalls, 0)

  const ecdRes = await fetchOptions({ organizationId, projectId: "10001", projectKey: "FORGED" })
  assert.equal(ecdRes.status, 200)
  const ecd = await ecdRes.json()
  assert.deepEqual(ecd.projects, [
    { id: "10001", key: "ECD", name: "Employee Copilot Demo" },
    { id: "10000", key: "KAN", name: "Product Team" },
  ])
  assert.deepEqual(
    ecd.issueTypes.map((i: { name: string }) => i.name),
    ["Story", "Bug", "Task"],
  )
  assert.deepEqual(ecd.assignees, [
    { id: DEFAULT_ASSIGNEE_ID, name: "phani9119", active: true },
    { id: "5dd32731b3a9c80fc0a3024b", name: "Phaneendra Sai", active: true },
  ])
  assert.equal(ecd.priorities.length, 5)

  const kanRes = await fetchOptions({ organizationId, projectId: "10000" })
  assert.equal(kanRes.status, 200)
  const kan = await kanRes.json()
  assert.deepEqual(
    kan.issueTypes.map((i: { name: string }) => i.name),
    ["Feature", "Task", "Story", "Bug"],
  )

  for (const failure of [
    () => Response.json({ error: "fail" }, { status: 500 }),
    () => Response.json({ projects: [] }),
    () => new Response("not json"),
  ]) {
    webhookResponse = failure
    assert.equal((await fetchOptions({ organizationId, projectId: "10001" })).status, 502)
  }
})

test("extracts and normalizes explicit Jira status requests without affecting creation or RAG queries", () => {
  assert.equal(extractJiraStatusIssueKey("What is the status of ECD-6?"), "ECD-6")
  assert.equal(extractJiraStatusIssueKey("Check ECD-6 status"), "ECD-6")
  assert.equal(extractJiraStatusIssueKey("Track ticket ecd-6"), "ECD-6")
  assert.equal(extractJiraStatusIssueKey("Could you check the status of Jira ticket ecd-12?"), "ECD-12")
  assert.equal(extractJiraStatusIssueKey("Check ABC-42 status"), "ABC-42")

  assert.equal(draftJiraTicket("What is the status of ECD-6?"), null)
  assert.equal(draftJiraTicket("Track ticket ECD-6"), null)
  assert.equal(extractJiraStatusIssueKey("Create a Jira ticket for ECD-6"), null)

  assert.equal(extractJiraStatusIssueKey("What is the VPN policy?"), null)
  assert.equal(extractJiraStatusIssueKey("How do I track a Jira ticket?"), null)
  assert.equal(extractJiraStatusIssueKey("What does ECD-6 policy say about VPN?"), null)
})

test("Jira status route enforces auth, membership, ECD allowlist, and validates webhook response", async (t) => {
  const organizationId = "11111111-1111-4111-8111-111111111111"
  const env = {
    NEXT_PUBLIC_SUPABASE_URL: "https://supabase.invalid",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
    ACTIVEPIECES_JIRA_STATUS_WEBHOOK_URL: "https://activepieces.invalid/api/v1/webhooks/status/sync/",
  }
  const previous = Object.entries(env).map(([key]) => [key, process.env[key]] as const)
  Object.assign(process.env, env)
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  let webhookCalls = 0
  let webhookResponse = () =>
    Response.json({
      success: true,
      ticketKey: "ECD-6",
      status: "To Do",
      summary: "VPN disconnects firs ticket",
      internalField: "do-not-expose",
    })

  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const token = new Headers(init?.headers).get("authorization")
    if (url.pathname === "/auth/v1/user") {
      return token === "Bearer expired"
        ? Response.json({ message: "Invalid session" }, { status: 401 })
        : Response.json({ id: "employee", role: "authenticated" })
    }
    if (url.pathname === "/rest/v1/rpc/enterprise_copilot_context") {
      assert.deepEqual(JSON.parse(String(init?.body)), { target_organization_id: organizationId })
      return Response.json(token === "Bearer inactive" ? [] : [{ organization_id: organizationId }])
    }
    webhookCalls++
    assert.equal(url.href, "https://activepieces.invalid/api/v1/webhooks/status/sync")
    assert.equal(init?.method, "POST")
    assert.equal(token, null)
    assert.deepEqual(JSON.parse(String(init?.body)), { issueKey: "ECD-6" })
    return webhookResponse()
  })

  const lookup = (body: unknown, token = "employee", contentType = "application/json") =>
    POST_STATUS(
      new Request("https://app.invalid/api/jira/status", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType },
        body: JSON.stringify(body),
      }),
    )

  assert.equal((await lookup({ organizationId, issueKey: "ECD-6" }, "expired")).status, 401)
  assert.equal((await lookup({ organizationId, issueKey: "ECD-6" }, "inactive")).status, 403)
  assert.equal((await lookup({ organizationId, issueKey: "ECD-6" }, "employee", "text/plain")).status, 415)

  for (const invalid of [
    null,
    { organizationId: "invalid", issueKey: "ECD-6" },
    { organizationId, issueKey: "" },
    { organizationId, issueKey: "ECD-0" },
    { organizationId, issueKey: "not-a-key" },
  ]) {
    assert.equal((await lookup(invalid)).status, 400)
  }

  for (const forbiddenKey of ["ABC-1", "ENG-12", "OPS-99"]) {
    assert.equal((await lookup({ organizationId, issueKey: forbiddenKey })).status, 403)
  }

  delete process.env.ACTIVEPIECES_JIRA_STATUS_WEBHOOK_URL
  assert.equal((await lookup({ organizationId, issueKey: "ECD-6" })).status, 503)
  process.env.ACTIVEPIECES_JIRA_STATUS_WEBHOOK_URL = env.ACTIVEPIECES_JIRA_STATUS_WEBHOOK_URL
  assert.equal(webhookCalls, 0)

  const ok = await lookup({ organizationId, issueKey: " ecd-6 " })
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), {
    ticketKey: "ECD-6",
    status: "To Do",
    summary: "VPN disconnects firs ticket",
  })
  assert.equal(webhookCalls, 1)

  webhookResponse = () => Response.json({ error: "Not found" }, { status: 404 })
  assert.equal((await lookup({ organizationId, issueKey: "ECD-6" })).status, 404)

  for (const invalidWebhook of [
    () => Response.json({ error: "private details" }, { status: 500 }),
    () => Response.json({ success: false, ticketKey: "ECD-6", status: "To Do", summary: "x" }),
    () => Response.json({ success: true, ticketKey: "ECD-99", status: "To Do", summary: "Mismatch" }),
    () => Response.json({ success: true, ticketKey: "ECD-6", status: "", summary: "Missing status" }),
    () => Response.json({ success: true, ticketKey: "ECD-6", status: "To Do" }),
    () => new Response("not JSON"),
    () => {
      throw new Error("Network failure with private webhook URL")
    },
  ]) {
    webhookResponse = invalidWebhook
    const response = await lookup({ organizationId, issueKey: "ECD-6" })
    assert.equal(response.status, 502)
  }
  assert.equal(webhookCalls, 9)
})
