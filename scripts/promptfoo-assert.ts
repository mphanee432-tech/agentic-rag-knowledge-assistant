import { assertValidAnswer, NO_EVIDENCE } from "../lib/chat-contract"
import type { GoldenCase } from "../lib/eval-dataset"

export default function checkResponse(output: unknown, context: { vars?: { expected_signals?: GoldenCase["expected_signals"] } }) {
  try {
    const response = typeof output === "string" ? JSON.parse(output) : output
    const signals = context.vars?.expected_signals
    if (!signals || !response || response.error || typeof response.text !== "string" || !Array.isArray(response.citations) ||
        !response.metrics || !Array.isArray(response.metrics.errors) || response.metrics.errors.length ||
        (response.output !== undefined && response.output !== response.text) ||
        response.citations.some((c: { id?: unknown; index?: unknown }) => !c || typeof c.id !== "string" || !c.id.trim() ||
          typeof c.index !== "number" || !Number.isInteger(c.index) || c.index < 1) ||
        new Set(response.citations.map((c: { index: number }) => c.index)).size !== response.citations.length) return false
    assertValidAnswer(response.text, response.citations, "stop")
    const refusal = response.text.trim() === NO_EVIDENCE
    // Whether a cited refusal actually rejects the forbidden request is a semantic judge decision.
    return (!refusal || signals.must_refuse) && response.text.length <= signals.max_chars &&
      (refusal || typeof response.context === "string" && response.context.trim().length > 0)
  } catch { return false }
}
