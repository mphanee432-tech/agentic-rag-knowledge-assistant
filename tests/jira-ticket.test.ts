import assert from "node:assert/strict"
import test from "node:test"
import { POST } from "../app/api/jira/create/route"
import { POST as POST_OPTIONS } from "../app/api/jira/options/route"
import { POST as POST_STATUS } from "../app/api/jira/status/route"
import { buildAccountSummary } from "../lib/account-summary"
import {
  ALLOWED_JIRA_PROJECTS,
  DEFAULT_JIRA_PROJECT_ID,
  draftJiraTicket,
  extractJiraStatusIssueKey,
  extractLatestJiraTicketKeyFromMessages,
  formatJiraStatusMessage,
  isKeylessJiraStatusQuery,
  JIRA_ALLOWED_ISSUE_KEY_PATTERN,
  JIRA_STATUS_CLARIFICATION_PROMPT,
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
      return Response.json(
        token === "Bearer inactive" || token === "Bearer nonmember" ? [] : [{ organization_id: organizationId }],
      )
    }
    if (url.pathname === "/rest/v1/demo_jira_access") {
      return Response.json({ enabled: true })
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
  assert.equal((await create(details, "nonmember")).status, 403)
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
    if (url.pathname === "/rest/v1/demo_jira_access") {
      return Response.json({ enabled: true })
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

test("buildAccountSummary derives exact Employee, Manager, CXO, Inactive, and missing membership states", () => {
  const orgId = "c0000000-0000-4000-8000-000000000001"
  assert.deepEqual(
    buildAccountSummary({
      email: "employee@deccanbridge.invalid",
      enterprise: { organization_id: orgId, can_upload_policy: false },
      accountStatus: { organization_id: orgId, organization_name: "DeccanBridge Software", role: "employee", is_active: true },
      demoJiraAccess: true,
    }),
    {
      email: "employee@deccanbridge.invalid",
      role: "Employee",
      organizationName: "DeccanBridge Software",
      accessStatus: "Active",
      jiraAccessAvailable: true,
    },
  )

  // Missing/NULL demo_jira_access defaults to Disabled even for active Enterprise employees
  assert.deepEqual(
    buildAccountSummary({
      email: "employee-null-jira@deccanbridge.invalid",
      enterprise: { organization_id: orgId, can_upload_policy: false },
      accountStatus: { organization_id: orgId, organization_name: "DeccanBridge Software", role: "employee", is_active: true },
      demoJiraAccess: null,
    }),
    {
      email: "employee-null-jira@deccanbridge.invalid",
      role: "Employee",
      organizationName: "DeccanBridge Software",
      accessStatus: "Active",
      jiraAccessAvailable: false,
    },
  )

  assert.deepEqual(
    buildAccountSummary({
      email: "manager@deccanbridge.invalid",
      enterprise: { organization_id: orgId, can_upload_policy: true },
      accountStatus: { organization_id: orgId, organization_name: "DeccanBridge Software", role: "manager", is_active: true },
      demoJiraAccess: true,
    }),
    {
      email: "manager@deccanbridge.invalid",
      role: "Manager",
      organizationName: "DeccanBridge Software",
      accessStatus: "Active",
      jiraAccessAvailable: true,
    },
  )

  assert.deepEqual(
    buildAccountSummary({
      email: "cxo@deccanbridge.invalid",
      enterprise: { organization_id: orgId, can_upload_policy: true },
      accountStatus: { organization_id: orgId, organization_name: "DeccanBridge Software", role: "cxo", is_active: true },
      demoJiraAccess: true,
    }),
    {
      email: "cxo@deccanbridge.invalid",
      role: "CXO",
      organizationName: "DeccanBridge Software",
      accessStatus: "Active",
      jiraAccessAvailable: true,
    },
  )

  assert.deepEqual(
    buildAccountSummary({
      email: "inactive@deccanbridge.invalid",
      enterprise: null,
      accountStatus: { organization_id: orgId, organization_name: "DeccanBridge Software", role: "employee", is_active: false },
      demoJiraAccess: true,
    }),
    {
      email: "inactive@deccanbridge.invalid",
      role: "Employee",
      organizationName: "DeccanBridge Software",
      accessStatus: "Inactive",
      jiraAccessAvailable: false,
    },
  )

  // Never labels users "Manager / CXO" when exact role is unknown
  assert.deepEqual(
    buildAccountSummary({
      email: "unknown-role@deccanbridge.invalid",
      enterprise: { organization_id: orgId, can_upload_policy: true },
      accountStatus: null,
      demoJiraAccess: true,
    }),
    {
      email: "unknown-role@deccanbridge.invalid",
      role: null,
      organizationName: "DeccanBridge Software",
      accessStatus: "Active",
      jiraAccessAvailable: true,
    },
  )

  assert.deepEqual(
    buildAccountSummary({
      email: "dummy@example.invalid",
      enterprise: null,
      accountStatus: null,
    }),
    {
      email: "dummy@example.invalid",
      role: null,
      organizationName: null,
      accessStatus: "No enterprise access",
      jiraAccessAvailable: false,
    },
  )
})

test("extracts and normalizes explicit Jira status requests without affecting creation or RAG queries", () => {
  assert.equal(extractJiraStatusIssueKey("What is the status of ECD-6?"), "ECD-6")
  assert.equal(extractJiraStatusIssueKey("What is the current status of ECD-6?"), "ECD-6")
  assert.equal(extractJiraStatusIssueKey("Can you tell me the current status of my Jira ticket ECD-6 right now?"), "ECD-6")
  assert.equal(extractJiraStatusIssueKey("Check status of this Jira ticket ECD-6 please"), "ECD-6")
  assert.equal(extractJiraStatusIssueKey("What is ECD-6's current status?"), "ECD-6")
  assert.equal(extractJiraStatusIssueKey("Check ECD-6 status"), "ECD-6")
  assert.equal(extractJiraStatusIssueKey("Track ticket ecd-6"), "ECD-6")
  assert.equal(extractJiraStatusIssueKey("Could you check the status of Jira ticket ecd-12?"), "ECD-12")
  assert.equal(extractJiraStatusIssueKey("Check ABC-42 status"), "ABC-42")

  assert.equal(isKeylessJiraStatusQuery("What is the status of the ticket I just created?"), true)
  assert.equal(isKeylessJiraStatusQuery("Check its current status please"), true)
  assert.equal(isKeylessJiraStatusQuery("What is the status of my ticket?"), true)
  assert.equal(isKeylessJiraStatusQuery("How do I track a Jira ticket?"), false)
  assert.equal(isKeylessJiraStatusQuery("What is the Jira workflow policy?"), false)

  assert.equal(
    extractLatestJiraTicketKeyFromMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Created Jira ticket **ECD-7**." },
    ]),
    "ECD-7",
  )
  assert.equal(
    extractLatestJiraTicketKeyFromMessages([
      { role: "assistant", content: formatJiraStatusMessage({ ticketKey: "ECD-6", status: "In Progress", summary: "VPN" }) },
    ]),
    "ECD-6",
  )
  assert.equal(extractJiraStatusIssueKey("Check status of kan-1"), "KAN-1")
  assert.equal(
    extractLatestJiraTicketKeyFromMessages([
      { role: "assistant", content: "Created Jira ticket **KAN-1**." },
    ]),
    "KAN-1",
  )
  assert.equal(
    extractLatestJiraTicketKeyFromMessages([
      { role: "assistant", content: formatJiraStatusMessage({ ticketKey: "KAN-1", status: "Idea", summary: "VPN" }) },
    ]),
    "KAN-1",
  )
  assert.deepEqual(
    ALLOWED_JIRA_PROJECTS.map((project) => project.key),
    ["ECD", "KAN"],
  )
  assert.equal(JIRA_ALLOWED_ISSUE_KEY_PATTERN.test("ECD-6"), true)
  assert.equal(JIRA_ALLOWED_ISSUE_KEY_PATTERN.test("KAN-1"), true)
  assert.equal(JIRA_ALLOWED_ISSUE_KEY_PATTERN.test("SEC-1"), false)
  assert.equal(
    JIRA_STATUS_CLARIFICATION_PROMPT,
    "Please share the Jira ticket ID (for example, ECD-6 or KAN-1) so I can check its status.",
  )

  assert.equal(draftJiraTicket("What is the status of ECD-6?"), null)
  assert.equal(draftJiraTicket("Track ticket ECD-6"), null)
  assert.equal(extractJiraStatusIssueKey("Create a Jira ticket for ECD-6"), null)

  assert.equal(extractJiraStatusIssueKey("What is the VPN policy?"), null)
  assert.equal(extractJiraStatusIssueKey("How do I track a Jira ticket?"), null)
  assert.equal(extractJiraStatusIssueKey("What does ECD-6 policy say about VPN?"), null)
})

test("Jira status route enforces auth, membership, ECD/KAN allowlist, and validates webhook response", async (t) => {
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
  let webhookResponse: ((issueKey: string) => Response) = (issueKey) =>
    Response.json({
      success: true,
      ticketKey: issueKey,
      status: issueKey.startsWith("KAN-") ? "Idea" : "To Do",
      summary: issueKey.startsWith("KAN-") ? "KAN summary" : "VPN disconnects firs ticket",
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
      return Response.json(
        token === "Bearer inactive" || token === "Bearer nonmember" ? [] : [{ organization_id: organizationId }],
      )
    }
    if (url.pathname === "/rest/v1/demo_jira_access") {
      return Response.json({ enabled: true })
    }
    webhookCalls++
    assert.equal(url.href, "https://activepieces.invalid/api/v1/webhooks/status/sync")
    assert.equal(init?.method, "POST")
    assert.equal(token, null)
    const parsedBody = JSON.parse(String(init?.body)) as { issueKey: string }
    assert.match(parsedBody.issueKey, /^(?:ECD-6|KAN-1)$/)
    return webhookResponse(parsedBody.issueKey)
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
    { organizationId, issueKey: "KAN-0" },
    { organizationId, issueKey: "not-a-key" },
  ]) {
    assert.equal((await lookup(invalid)).status, 400)
  }

  for (const forbiddenKey of ["ABC-1", "ENG-12", "OPS-99", "SEC-1"]) {
    const forbidden = await lookup({ organizationId, issueKey: forbiddenKey })
    assert.equal(forbidden.status, 403)
    assert.deepEqual(await forbidden.json(), {
      error: "Only ECD and KAN project Jira tickets are accessible in this demo.",
    })
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

  const okKan = await lookup({ organizationId, issueKey: " kan-1 " })
  assert.equal(okKan.status, 200)
  assert.deepEqual(await okKan.json(), {
    ticketKey: "KAN-1",
    status: "Idea",
    summary: "KAN summary",
  })
  assert.equal(webhookCalls, 2)

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
  assert.equal(webhookCalls, 10)
})

test("WP9.13: demo Jira opt-in authorizes ECD/KAN without enterprise membership and denies opt-out users", async (t) => {
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
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const token = new Headers(init?.headers).get("authorization")
    if (url.pathname === "/auth/v1/user") {
      if (token === "Bearer enrolled-optout") {
        return Response.json({
          id: "enrolled-optout-user",
          role: "authenticated",
          user_metadata: { demo_jira_access: false, demo_department: "Engineering" },
        })
      }
      return Response.json({ id: token === "Bearer demo-enabled" ? "demo-user" : "plain-user", role: "authenticated" })
    }
    if (url.pathname === "/rest/v1/demo_jira_access") {
      if (token === "Bearer demo-enabled") return Response.json({ enabled: true })
      if (token === "Bearer enrolled-optout") return Response.json({ enabled: false })
      return Response.json(null)
    }
    if (url.pathname === "/rest/v1/rpc/enterprise_account_status") {
      return Response.json(
        token === "Bearer enrolled-optout"
          ? [{ organization_id: "c0000000-0000-4000-8000-000000000001", role: "employee", is_active: true }]
          : [],
      )
    }
    if (url.pathname === "/rest/v1/rpc/enterprise_copilot_context") {
      return Response.json(
        token === "Bearer enrolled-optout"
          ? [{ organization_id: "c0000000-0000-4000-8000-000000000001", can_upload_policy: false }]
          : [],
      )
    }
    if (url.href === "https://activepieces.invalid/api/v1/webhooks/options/sync") {
      const body = JSON.parse(String(init?.body)) as { projectId: string }
      return Response.json(makeLiveOptionsPayload(body.projectId))
    }
    if (url.href === "https://activepieces.invalid/api/v1/webhooks/example/sync") {
      webhookCalls++
      return Response.json({ success: true, ticketKey: "ECD-99" })
    }
    throw new Error(`Unexpected URL: ${url.href}`)
  })

  const postOptions = (body: unknown, token: string) =>
    POST_OPTIONS(
      new Request("https://app.invalid/api/jira/options", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    )

  const postCreate = (body: unknown, token: string) =>
    POST(
      new Request("https://app.invalid/api/jira/create", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    )

  // Opt-out user: 403 on both /api/jira/options and /api/jira/create
  assert.equal((await postOptions({}, "plain-user")).status, 403)
  assert.equal(
    (
      await postCreate(
        {
          summary: "Opt-out test",
          description: "Should be rejected",
          projectId: DEFAULT_JIRA_PROJECT_ID,
          issueTypeId: DEFAULT_ISSUE_TYPE_ID,
          assigneeId: DEFAULT_ASSIGNEE_ID,
          priorityId: DEFAULT_PRIORITY_ID,
        },
        "plain-user",
      )
    ).status,
    403,
  )
  assert.equal(webhookCalls, 0)

  // Opt-in user: authorized for ECD and KAN, rejected for non-allowlisted project
  const optionsRes = await postOptions({}, "demo-enabled")
  assert.equal(optionsRes.status, 200)
  const optionsJson = (await optionsRes.json()) as { projects: Array<{ id: string; key: string }> }
  assert.deepEqual(
    optionsJson.projects.map((p) => p.key),
    ["ECD", "KAN"],
  )

  assert.equal(
    (
      await postCreate(
        {
          summary: "Unauthorized project",
          description: "Should be rejected",
          projectId: "10999",
          issueTypeId: DEFAULT_ISSUE_TYPE_ID,
          assigneeId: DEFAULT_ASSIGNEE_ID,
          priorityId: DEFAULT_PRIORITY_ID,
        },
        "demo-enabled",
      )
    ).status,
    403,
  )
  assert.equal(webhookCalls, 0)

  const createRes = await postCreate(
    {
      summary: "Demo Jira opt-in ticket",
      description: "Created after explicit confirmation",
      projectId: DEFAULT_JIRA_PROJECT_ID,
      issueTypeId: DEFAULT_ISSUE_TYPE_ID,
      assigneeId: DEFAULT_ASSIGNEE_ID,
      priorityId: DEFAULT_PRIORITY_ID,
    },
    "demo-enabled",
  )
  assert.equal(createRes.status, 200)
  assert.deepEqual(await createRes.json(), { ticketKey: "ECD-99" })
  assert.equal(webhookCalls, 1)

  // Account summary accurately reflects Jira access without granting enterprise roles or org membership
  assert.deepEqual(
    buildAccountSummary({
      email: "demo@example.invalid",
      enterprise: null,
      accountStatus: null,
      demoJiraAccess: true,
    }),
    {
      email: "demo@example.invalid",
      role: null,
      organizationName: null,
      accessStatus: "No enterprise access",
      jiraAccessAvailable: true,
    },
  )
  assert.deepEqual(
    buildAccountSummary({
      email: "plain@example.invalid",
      enterprise: null,
      accountStatus: null,
      demoJiraAccess: false,
    }),
    {
      email: "plain@example.invalid",
      role: null,
      organizationName: null,
      accessStatus: "No enterprise access",
      jiraAccessAvailable: false,
    },
  )

  // WP9.15: Enrolled enterprise employee with explicit Jira opt-out preserves Jira opt-out and department name
  const orgId = "c0000000-0000-4000-8000-000000000001"
  assert.deepEqual(
    buildAccountSummary({
      email: "phani9119en@gmail.com",
      enterprise: { organization_id: orgId, can_upload_policy: false },
      accountStatus: {
        organization_id: orgId,
        organization_name: "DeccanBridge Software",
        department_name: "Engineering",
        role: "employee",
        is_active: true,
      },
      demoJiraAccess: false,
    }),
    {
      email: "phani9119en@gmail.com",
      role: "Employee",
      organizationName: "DeccanBridge Software",
      departmentName: "Engineering",
      accessStatus: "Active",
      jiraAccessAvailable: false,
    },
  )

  assert.equal((await postOptions({ organizationId: orgId }, "enrolled-optout")).status, 403)
  assert.equal(
    (
      await postCreate(
        {
          organizationId: orgId,
          summary: "Opt-out enterprise user",
          description: "Must not override Jira opt-out",
          projectId: DEFAULT_JIRA_PROJECT_ID,
          issueTypeId: DEFAULT_ISSUE_TYPE_ID,
          assigneeId: DEFAULT_ASSIGNEE_ID,
          priorityId: DEFAULT_PRIORITY_ID,
        },
        "enrolled-optout",
      )
    ).status,
    403,
  )
  assert.equal(webhookCalls, 1)
})

test("WP9.24: authoritative demo_jira_access enforces backend, chatbot, UI, status separation, and confirmation", async (t) => {
  const { POST: POST_CHAT } = await import("../app/api/chat/route")
  const {
    CAPABILITY_RESPONSE_WITH_JIRA,
    CAPABILITY_RESPONSE_WITHOUT_JIRA,
  } = await import("../lib/chat-input")
  const fs = await import("node:fs/promises")

  const orgId = "c0000000-0000-4000-8000-000000000001"
  const wrongOrgId = "99999999-9999-4999-8999-999999999999"
  const env = {
    NEXT_PUBLIC_SUPABASE_URL: "https://supabase.invalid",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
    ACTIVEPIECES_JIRA_WEBHOOK_URL: "https://activepieces.invalid/api/v1/webhooks/example/sync/",
    ACTIVEPIECES_JIRA_OPTIONS_WEBHOOK_URL: "https://activepieces.invalid/api/v1/webhooks/options/sync/",
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

  t.mock.method(console, "info", () => {})
  t.mock.method(console, "error", () => {})

  type UserProfile = {
    id: string
    department: string | null
    active: boolean | null // null = personal/demo user with no org row
    metaJira?: boolean
    dbJira: boolean | null | "error"
  }

  const users: Record<string, UserProfile> = {
    "eng-enabled": { id: "u-eng-1", department: "Engineering", active: true, metaJira: true, dbJira: true },
    "eng-disabled": { id: "u-eng-2", department: "Engineering", active: true, metaJira: false, dbJira: false },
    "eng-missing": { id: "u-eng-3", department: "Engineering", active: true, dbJira: null },
    "db-error": { id: "u-err", department: "Engineering", active: true, metaJira: true, dbJira: "error" },
    "meta-true-db-false": { id: "u-m1", department: "Engineering", active: true, metaJira: true, dbJira: false },
    "meta-false-db-true": { id: "u-m2", department: "Engineering", active: true, metaJira: false, dbJira: true },
    "inactive-emp": { id: "u-inact", department: "Engineering", active: false, metaJira: true, dbJira: true },
    "standalone-optin": { id: "u-pers", department: null, active: null, metaJira: false, dbJira: true },
  }

  let createWebhookCalls = 0
  let statusWebhookCalls = 0
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? ""

    if (url.pathname === "/auth/v1/user") {
      const profile = users[token]
      if (!profile) return Response.json({ message: "Unauthorized" }, { status: 401 })
      return Response.json({
        id: profile.id,
        role: "authenticated",
        user_metadata: profile.metaJira === undefined ? {} : { demo_jira_access: profile.metaJira },
      })
    }

    const profile = users[token]
    if (url.pathname === "/rest/v1/demo_jira_access") {
      if (!profile || profile.dbJira === "error") {
        return Response.json({ message: "Database lookup failed" }, { status: 500 })
      }
      return Response.json(profile.dbJira === null ? null : { enabled: profile.dbJira })
    }

    if (url.pathname === "/rest/v1/rpc/enterprise_account_status") {
      if (!profile || profile.active === null) return Response.json([])
      return Response.json([{
        organization_id: orgId,
        organization_name: "DeccanBridge Software",
        department_name: profile.department,
        role: "employee",
        is_active: profile.active,
      }])
    }

    if (url.pathname === "/rest/v1/rpc/enterprise_copilot_context") {
      const { target_organization_id } = JSON.parse(String(init?.body ?? "{}")) as { target_organization_id?: string }
      if (!profile || profile.active !== true || target_organization_id !== orgId) {
        return Response.json([])
      }
      return Response.json([{ organization_id: orgId, can_upload_policy: false }])
    }

    if (url.href === "https://activepieces.invalid/api/v1/webhooks/options/sync") {
      const body = JSON.parse(String(init?.body)) as { projectId: string }
      return Response.json(makeLiveOptionsPayload(body.projectId))
    }
    if (url.href === "https://activepieces.invalid/api/v1/webhooks/example/sync") {
      createWebhookCalls++
      return Response.json({ success: true, ticketKey: "ECD-200" })
    }
    if (url.href === "https://activepieces.invalid/api/v1/webhooks/status/sync") {
      statusWebhookCalls++
      return Response.json({ success: true, ticketKey: "ECD-6", status: "In Progress", summary: "VPN issue" })
    }
    throw new Error(`Unexpected URL: ${url.href}`)
  })

  const baseTicket = {
    summary: "WP9.24 test ticket",
    description: "Verify authoritative Jira permissions",
    projectId: DEFAULT_JIRA_PROJECT_ID,
    issueTypeId: DEFAULT_ISSUE_TYPE_ID,
    assigneeId: DEFAULT_ASSIGNEE_ID,
    priorityId: DEFAULT_PRIORITY_ID,
  }
  const req = (route: string, body: unknown, token: string) =>
    new Request(`https://app.invalid${route}`, {
      method: "POST",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

  // 1, 6, 13: Explicit DB enabled (even if metadata=false) & standalone non-deactivated opt-in allowed
  for (const allowedToken of ["eng-enabled", "meta-false-db-true"]) {
    assert.equal((await POST_OPTIONS(req("/api/jira/options", { organizationId: orgId }, allowedToken))).status, 200)
    assert.equal((await POST(req("/api/jira/create", { ...baseTicket, organizationId: orgId }, allowedToken))).status, 200)
  }
  assert.equal((await POST(req("/api/jira/create", baseTicket, "standalone-optin"))).status, 200)
  assert.equal(createWebhookCalls, 3)

  // 2, 3, 5, 7, 11, 13: DB disabled, NULL/missing, or metadata-only true -> 403 (with & without organizationId)
  for (const deniedToken of ["eng-disabled", "eng-missing", "meta-true-db-false"]) {
    for (const payloadOrg of [orgId, undefined]) {
      const optBody = payloadOrg ? { organizationId: payloadOrg } : {}
      const createBody = payloadOrg ? { ...baseTicket, organizationId: payloadOrg } : baseTicket
      assert.equal((await POST_OPTIONS(req("/api/jira/options", optBody, deniedToken))).status, 403)
      assert.equal((await POST(req("/api/jira/create", createBody, deniedToken))).status, 403)
    }
  }

  // 4: Database permission lookup failure fails closed (non-2xx, zero webhooks)
  assert.equal((await POST_OPTIONS(req("/api/jira/options", { organizationId: orgId }, "db-error"))).status, 500)
  assert.equal((await POST(req("/api/jira/create", { ...baseTicket, organizationId: orgId }, "db-error"))).status, 500)

  // 8: Inactive Enterprise employee denied BOTH with organizationId AND when omitting organizationId
  assert.equal((await POST_OPTIONS(req("/api/jira/options", { organizationId: orgId }, "inactive-emp"))).status, 403)
  assert.equal((await POST(req("/api/jira/create", { ...baseTicket, organizationId: orgId }, "inactive-emp"))).status, 403)
  assert.equal((await POST_OPTIONS(req("/api/jira/options", {}, "inactive-emp"))).status, 403)
  assert.equal((await POST(req("/api/jira/create", baseTicket, "inactive-emp"))).status, 403)

  // 9: Unauthorized organization denied
  assert.equal((await POST_OPTIONS(req("/api/jira/options", { organizationId: wrongOrgId }, "eng-enabled"))).status, 403)
  assert.equal((await POST(req("/api/jira/create", { ...baseTicket, organizationId: wrongOrgId }, "eng-enabled"))).status, 403)

  // 10: Unauthenticated requests denied with 401
  assert.equal((await POST_OPTIONS(req("/api/jira/options", { organizationId: orgId }, "invalid"))).status, 401)
  assert.equal((await POST(req("/api/jira/create", { ...baseTicket, organizationId: orgId }, "invalid"))).status, 401)
  assert.equal((await POST_STATUS(req("/api/jira/status", { organizationId: orgId, issueKey: "ECD-6" }, "invalid"))).status, 401)
  assert.equal(createWebhookCalls, 3)

  // 12: Jira-disabled & NULL-Jira active Enterprise employees CAN still check Jira status
  for (const statusToken of ["eng-disabled", "eng-missing", "meta-true-db-false"]) {
    const statusRes = await POST_STATUS(req("/api/jira/status", { organizationId: orgId, issueKey: "ECD-6" }, statusToken))
    assert.equal(statusRes.status, 200)
  }
  assert.equal((await POST_STATUS(req("/api/jira/status", { organizationId: orgId, issueKey: "ECD-6" }, "inactive-emp"))).status, 403)
  assert.equal((await POST_STATUS(req("/api/jira/status", { organizationId: wrongOrgId, issueKey: "ECD-6" }, "eng-enabled"))).status, 403)
  assert.equal(statusWebhookCalls, 3)

  // 14: Chatbot capability messaging & UI summary agree with backend authorization
  for (const [token, expectAvailable] of [
    ["eng-enabled", true],
    ["meta-false-db-true", true],
    ["eng-disabled", false],
    ["eng-missing", false],
    ["meta-true-db-false", false],
    ["db-error", false],
  ] as const) {
    const chatRes = await POST_CHAT(req("/api/chat", { organizationId: orgId, query: "what can you do?", stream: false }, token))
    assert.equal(chatRes.status, 200)
    const chatJson = (await chatRes.json()) as { text: string }
    assert.equal(chatJson.text, expectAvailable ? CAPABILITY_RESPONSE_WITH_JIRA : CAPABILITY_RESPONSE_WITHOUT_JIRA)

    const profile = users[token]
    const uiSummary = buildAccountSummary({
      email: `${token}@deccanbridge.invalid`,
      enterprise: { organization_id: orgId, can_upload_policy: false },
      accountStatus: { organization_id: orgId, organization_name: "DeccanBridge Software", role: "employee", is_active: true },
      demoJiraAccess: typeof profile.dbJira === "boolean" ? profile.dbJira : false,
    })
    assert.equal(uiSummary.jiraAccessAvailable, expectAvailable)
  }

  // Inactive Enterprise employee UI stays Disabled even when dbJira is true
  assert.equal(
    buildAccountSummary({
      email: "inactive@deccanbridge.invalid",
      enterprise: null,
      accountStatus: { organization_id: orgId, organization_name: "DeccanBridge Software", role: "employee", is_active: false },
      demoJiraAccess: true,
    }).jiraAccessAvailable,
    false,
  )

  // 15: Explicit confirmation stays required in normal UI flow (drafting opens form, only Confirm calls /api/jira/create)
  const [chatContainerSrc, draftComponentSrc] = await Promise.all([
    fs.readFile(new URL("../components/chat/chat-container.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../components/jira/jira-ticket-draft.tsx", import.meta.url), "utf8"),
  ])
  assert.match(chatContainerSrc, /const canDraftJira = Boolean\(accountSummary\?\.jiraAccessAvailable\)/)
  assert.match(chatContainerSrc, /openJiraDraft\(draft\)/)
  assert.doesNotMatch(chatContainerSrc, /\/api\/jira\/create/)
  assert.match(draftComponentSrc, /onClick=\{onConfirm\}[\s\S]*Confirm/)
  assert.match(draftComponentSrc, /fetch\("\/api\/jira\/create"/)
})
