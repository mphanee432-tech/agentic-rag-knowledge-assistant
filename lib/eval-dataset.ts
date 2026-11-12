export const GOLDEN_CATEGORIES = {
  "Fact-Based Lookups": 23, "Edge Cases & Ambiguity": 10, "Multi-Hop Synthesis": 7,
  "Adversarial & Refusals": 8, "Regression Testing": 2,
} as const

export interface GoldenCase {
  id: number
  category: keyof typeof GOLDEN_CATEGORIES
  description: string
  query: string
  projectId: string
  expected_signals: { ground_truth_keywords: string[]; require_citations: boolean; must_refuse: boolean; max_chars: number }
  rubric: string
}

export function validateGoldenDataset(value: unknown, full = true): asserts value is GoldenCase[] {
  if (!Array.isArray(value) || !value.length) throw new Error("Expected a nonempty canonical golden dataset.")
  const ids = new Set<number>(), queries = new Set<string>()
  for (const row of value) {
    const signals = row?.expected_signals
    if (!row || !Number.isInteger(row.id) || row.id < 1 || ids.has(row.id) ||
        ![row.description, row.query, row.rubric].every(text => typeof text === "string" && text.trim()) ||
        row.query.length > 2500 || queries.has(row.query.trim().toLowerCase()) ||
        !Object.hasOwn(GOLDEN_CATEGORIES, row.category) ||
        typeof row.projectId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.projectId) ||
        !signals || typeof signals.must_refuse !== "boolean" || typeof signals.require_citations !== "boolean" ||
        signals.must_refuse !== (row.category === "Adversarial & Refusals") || signals.require_citations === signals.must_refuse ||
        !Number.isInteger(signals.max_chars) || signals.max_chars < 1 || signals.max_chars > 3000 ||
        !Array.isArray(signals.ground_truth_keywords) ||
        !signals.ground_truth_keywords.every((word: unknown) => typeof word === "string" && word.trim())) {
      throw new Error(`Invalid or duplicate golden case ${row?.id ?? "without id"}.`)
    }
    ids.add(row.id)
    queries.add(row.query.trim().toLowerCase())
  }
  if (full && Object.entries(GOLDEN_CATEGORIES).some(([category, count]) => value.filter(row => row.category === category).length !== count)) {
    throw new Error("Expected exactly 50 cases in the 23/10/7/8/2 category split.")
  }
}
