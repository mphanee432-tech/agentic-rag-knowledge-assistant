import assert from "node:assert/strict"
import test from "node:test"
import golden from "../evals/golden_dataset.json"
import { validateGoldenDataset } from "../lib/eval-dataset"
import { promptfooTests } from "../scripts/prepare-promptfoo"
import checkResponse from "../scripts/promptfoo-assert"
import { regressionCandidates } from "../scripts/sync-telemetry-to-eval"
import { NO_EVIDENCE } from "../lib/chat-contract"

test("canonical golden suite and Promptfoo adapter preserve all 50 cases and signals", () => {
  validateGoldenDataset(golden)
  const before = JSON.stringify(golden)
  const cases = promptfooTests(golden, "staging-project")
  assert.equal(cases.length, 50)
  assert.equal(cases[0].vars.projectId, "staging-project")
  for (let i = 0; i < cases.length; i++) {
    assert.equal(cases[i].vars.query, golden[i].query)
    assert.deepEqual(cases[i].vars.expected_signals, golden[i].expected_signals)
    assert.equal(cases[i].assert[0].value, "file://scripts/promptfoo-assert.ts")
  }
  assert.equal(JSON.stringify(golden), before)
})

test("invalid, duplicate and legacy-shaped cases cannot be promoted to golden", () => {
  for (const invalid of [[], [{ description: "Legacy", vars: { query: "Q" }, assert: [] }],
                         golden.slice(0, 49), [...golden, golden[0]]]) {
    assert.throws(() => validateGoldenDataset(invalid))
  }
  for (const patch of [{ query: "" }, { query: "x".repeat(2501) }, { category: "Unknown" }, { id: true },
                       { rubric: "" }, { projectId: "bad" }, { expected_signals: {} }]) {
    const invalid = structuredClone(golden)
    Object.assign(invalid[0], patch)
    assert.throws(() => validateGoldenDataset(invalid))
  }
})

test("Promptfoo deterministic assertion uses the full response and case expectations", () => {
  const context = { vars: { expected_signals: golden[0].expected_signals } }
  const response = { text: "Answer [Chunk 1]", context: "Authoritative evidence",
    citations: [{ id: "a", index: 1, content: "Evidence" }], metrics: { errors: [] } }
  assert.equal(checkResponse(JSON.stringify(response), context), true)
  for (const patch of [{ error: "HTTP failed" }, { text: "" }, { text: "Uncited" },
                       { text: "Answer [Chunk 99]" }, { context: "" }, { output: "Wrong answer" },
                       { metrics: { errors: ["Provider failed"] } }, { citations: [{ id: "", index: 1 }] }]) {
    assert.equal(checkResponse({ ...response, ...patch }, context), false)
  }
  const refusal = { vars: { expected_signals: golden[40].expected_signals } }
  assert.equal(checkResponse({ ...response, text: "Uncited refusal" }, refusal), false)
  assert.equal(checkResponse({ ...response, text: "I cannot export that; the policy prohibits it [Chunk 1]" }, refusal), true)
  assert.equal(checkResponse({ ...response, text: NO_EVIDENCE, context: "", citations: [] }, refusal), true)
  assert.equal(checkResponse({ ...response, text: NO_EVIDENCE, citations: [] }, context), false)
})

test("telemetry produces deduplicated review candidates without altering the golden suite", () => {
  validateGoldenDataset(golden)
  const before = JSON.stringify(golden)
  const logs = [
    { id: "known", query_text: golden[0].query, project_id: golden[0].projectId },
    { id: "new", query_text: "New regression", project_id: golden[0].projectId },
    { id: "duplicate", query_text: "NEW REGRESSION", project_id: golden[0].projectId },
  ]
  const candidates = regressionCandidates(logs, golden)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].source_interaction_id, "new")
  assert.equal(candidates[0].review_required, true)
  assert.equal(JSON.stringify(golden), before)
})
