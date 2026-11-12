import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createClient } from "@supabase/supabase-js"
import { config } from "dotenv"
import { validateGoldenDataset, type GoldenCase } from "../lib/eval-dataset"

type NegativeLog = { id: string; query_text: string; project_id: string; feedback?: { issue_tag?: string } }

export function regressionCandidates(logs: NegativeLog[], golden: GoldenCase[]) {
  const seen = new Set(golden.map(row => JSON.stringify([row.projectId, row.query.trim().toLowerCase()])))
  return logs.filter(log => {
    if (typeof log.query_text !== "string" || !log.query_text.trim() || log.query_text.length > 2500) return false
    const key = JSON.stringify([log.project_id, log.query_text.trim().toLowerCase()])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).map(log => ({ source_interaction_id: log.id, category: "Regression Testing", projectId: log.project_id,
    query: log.query_text, issue: log.feedback?.issue_tag || "Telemetry reported failure", review_required: true }))
}

async function main() {
  config({ path: ".env.local" }); config({ path: ".env" })
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("Service credentials are required to collect review candidates.")
  const output = resolve("evals/regression_candidates.json")
  if (existsSync(output)) throw new Error("Review or move the existing regression_candidates.json before collecting again.")
  const golden: unknown = JSON.parse(readFileSync("evals/golden_dataset.json", "utf8"))
  validateGoldenDataset(golden)
  const { data, error } = await createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    .from("interactions").select("id, query_text, project_id, feedback").eq("feedback->>rating", "thumbs_down")
    .order("created_at", { ascending: false }).limit(20)
  if (error) throw new Error("Unable to read negative telemetry.")
  const candidates = regressionCandidates(data || [], golden)
  writeFileSync(output, JSON.stringify(candidates, null, 2) + "\n", { flag: "wx" })
  console.log(`Saved ${candidates.length} review candidates. The 50-case golden suite was not modified.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : "Sync failed"); process.exitCode = 1 })
}
