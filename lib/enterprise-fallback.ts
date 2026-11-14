import type { SupabaseClient } from "@supabase/supabase-js"

const questions = {
  D01: "What are the general employee responsibilities in the Employee Handbook?",
  D02: "How do I request leave under the Leave and Attendance Policy?",
  D04: "What does the Engineering SOP require before approving a pull request?",
  D05: "How are product feature requests submitted and prioritized?",
  D06: "When and how should I escalate a project risk?",
  D07: "What does the Design Handoff and Accessibility Standard require for handoff to Engineering?",
  D08: "How do I submit an equipment or service request?",
  D09: "What approvals are required before launching a marketing campaign?",
  D10: "How do I submit a travel expense reimbursement claim?",
} as const

export async function getEnterpriseFallbackQuestions(
  supabase: SupabaseClient,
  organizationId: string,
  signal: AbortSignal,
): Promise<string[]> {
  try {
    const { data, error } = await supabase.rpc("enterprise_fallback_documents", {
      target_organization_id: organizationId,
    }).abortSignal(AbortSignal.any([signal, AbortSignal.timeout(2000)]))
    if (error || !Array.isArray(data)) return []

    const available = Object.entries(questions).filter(([code]) => data.some(row => row.code === code))
    const local = available.filter(([code]) => data.some(row => row.code === code && row.own_department === true))
    const selected = [...new Set([...local.slice(0, 2), ...available])].slice(0, 4)
    return selected.length >= 3 ? selected.map(([, question]) => question) : []
  } catch {
    return []
  }
}
