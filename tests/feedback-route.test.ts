import assert from "node:assert/strict"
import test from "node:test"
import { POST } from "../app/api/feedback/route"

test("feedback preserves caller-scoped ownership checks and its JSONB response contract", async t => {
  const env = { NEXT_PUBLIC_SUPABASE_URL: "https://feedback-test.invalid", NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-anon" }
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const interactionId = "30000000-0000-4000-8000-000000000001"
  const projectId = "20000000-0000-4000-8000-000000000001"
  const cases = [
    { name: "owner A feedback", actor: "10000000-0000-4000-8000-000000000001", status: 200, patch: true },
    { name: "owner B feedback", actor: "10000000-0000-4000-8000-000000000002", status: 200, patch: true },
    { name: "cross-user interaction hidden by RLS", hidden: true, status: 404 },
    { name: "mismatched ownership hidden by RLS", hidden: true, status: 404 },
    { name: "unknown interaction", hidden: true, status: 404 },
    { name: "project ownership guard rejects a leaked interaction", foreignProject: true, status: 404 },
    { name: "invalid authentication cannot write", invalidSession: true, status: 401 },
    { name: "zero-row update cannot report success", missingUpdate: true, status: 404, patch: true },
    { name: "database failure cannot report success", updateError: true, status: 500, patch: true },
    { name: "invalid feedback cannot write", invalidInput: true, status: 400 },
  ]
  for (const scenario of cases) {
    await t.test(scenario.name, async st => {
      st.mock.method(console, "error", () => {})
      const actor = scenario.actor || "10000000-0000-4000-8000-000000000001"
      const patches: Array<{ feedback: Record<string, unknown> }> = []
      const unexpected: string[] = []
      let unscopedRequests = 0
      let interactionReads = 0
      st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        const headers = new Headers(init?.headers)
        if (url.hostname !== "feedback-test.invalid" || headers.get("apikey") !== env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
            headers.get("authorization") !== "Bearer synthetic-token") {
          unscopedRequests++
          throw new Error("Feedback must use only caller-scoped synthetic credentials")
        }
        if (url.pathname === "/auth/v1/user") return scenario.invalidSession
          ? Response.json({ message: "Invalid session" }, { status: 401 })
          : Response.json({ id: actor, aud: "authenticated", role: "authenticated" })
        if (url.pathname === "/rest/v1/projects") {
          assert.equal(url.searchParams.get("id"), `eq.${projectId}`)
          assert.equal(url.searchParams.get("user_id"), `eq.${actor}`)
          return Response.json(scenario.foreignProject ? [] : [{ id: projectId, user_id: actor }])
        }
        if (url.pathname === "/rest/v1/interactions") {
          assert.equal(url.searchParams.get("id"), `eq.${interactionId}`)
          if (init?.method === "PATCH") {
            assert.equal(url.searchParams.get("project_id"), `eq.${projectId}`)
            assert.equal(url.searchParams.get("select"), "id")
            patches.push(JSON.parse(String(init.body)))
            if (scenario.updateError) return Response.json({ message: "Synthetic database failure" }, { status: 400 })
            return Response.json(scenario.missingUpdate ? [] : [{ id: interactionId }])
          }
          interactionReads++
          assert.equal(url.searchParams.get("select"), "project_id")
          return Response.json(scenario.hidden ? [] : [{ project_id: projectId }])
        }
        unexpected.push(url.pathname)
        throw new Error("Unexpected synthetic request")
      })
      const response = await POST(new Request("https://app.invalid/api/feedback", {
        method: "POST", headers: { Authorization: "Bearer synthetic-token", "Content-Type": "application/json" },
        body: JSON.stringify({ interactionId, rating: scenario.invalidInput ? "invalid" : "thumbs_up",
          issueTag: "test", comment: "Synthetic feedback", user_id: "forged-client-user" }),
      }))
      assert.equal(response.status, scenario.status)
      assert.equal(unscopedRequests, 0)
      assert.deepEqual(unexpected, [])
      assert.equal(interactionReads, scenario.invalidSession || scenario.invalidInput ? 0 : 1)
      assert.equal(patches.length, scenario.patch ? 1 : 0)
      for (const patch of patches) {
        assert.deepEqual(Object.keys(patch), ["feedback"])
        assert.deepEqual(Object.keys(patch.feedback).sort(), ["comment", "issue_tag", "rating", "updated_at"])
        assert.equal(patch.feedback.rating, "thumbs_up")
        assert.equal(patch.feedback.issue_tag, "test")
        assert.equal(patch.feedback.comment, "Synthetic feedback")
        assert.equal(typeof patch.feedback.updated_at, "string")
        assert.ok(!Number.isNaN(Date.parse(patch.feedback.updated_at as string)))
      }
      const body = await response.json()
      if (scenario.status === 200) {
        assert.deepEqual(Object.keys(body).sort(), ["feedback", "success"])
        assert.equal(body.success, true)
        assert.deepEqual(body.feedback, patches[0].feedback)
      } else {
        assert.equal(body.success, undefined)
        assert.equal(typeof body.error, "string")
      }
    })
  }
})
