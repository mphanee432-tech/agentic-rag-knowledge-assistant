# WP9.34 — Manual Answer Completeness Evaluation (V0 Enterprise RAG)

> **Scope & Status Note:** This is a **read-only manual completeness review** of 10 saved **V0** Enterprise RAG responses in `prompt_experiments/v0_results.json`. No live Gemini calls, evaluator runs, prompt edits, or database changes were performed. Existing WP9.33 V0 prompt restoration (`lib/prompts/systemPrompt.ts` matching `prompt_experiments/V0-enterprise-prompt.txt`) remains active and untouched.

---

## 1. Method & Sample Selection Overview

### Selection & Authority
- **Sample:** 10 intentionally complex procedural and policy-boundary cases selected across Company Policy (`E014`, `E015`, `E019`, `E028`, `E030`) and Department Policy (`E033`, `E035`, `E038`, `E039`, `E040`).
- **Statistical caveat (Reviewer Judgment):** Because this sample targets multi-step workflows, exceptions, and cross-section policies, its mean completeness is **not** a statistically representative estimate of all 50 golden cases.
- **Authoritative inputs:** Golden questions and expectations from `enterprise_golden_50.json`; stored V0 answers (`chatbot_response.text`, `citations`) and authorized retrieved evidence (`chatbot_response.context`) from `prompt_experiments/v0_results.json`. V1 outputs were excluded from checklist derivation and scoring.

### Checklist & Scoring Protocol
1. **Checklist derivation (before scoring):** For each case, 4–8 essential policy points were derived strictly from the golden question and the retrieved `[Chunk N]` evidence without consulting the V0 answer or requiring facts outside retrieved context. Where the policy document explicitly marks a parameter as unapproved or open (for example, formal reporting channels, exact threshold boundary at ₹500, severity matrix, or WCAG level), it is recorded as an **Evidence Limitation** rather than penalized as an omission.
2. **Equal-weight scoring:**
   - **Covered:** Explicitly and accurately addressed in the V0 answer.
   - **Missing:** Omitted despite explicit supporting evidence in retrieved `[Chunk N]` text.
   - **Incorrect:** Contradicted or materially misrepresented.
   - $\text{Completeness (\%)} = \frac{\text{Covered}}{\text{Total Applicable Essential Points}} \times 100$.
3. **Separation of dimensions:** Completeness is evaluated independently from automated correctness (`correct_probability`), groundedness (`grounded_probability`), citation validity, and security gates.
4. **Actionability / Omission Importance (Reviewer Judgment):** Each case's omissions are rated (`None`, `Low`, `Low–Moderate`, `Moderate`, `High`) based on whether missing details could materially change what an employee does in practice.

---

## 2. Summary Results Table

*(All 10 cases achieved `PASS` on automated correctness, groundedness, citations, and format in V0; `Incorrect = 0` across every case below.)*

| Case ID | Golden Question | V0 Len (chars) | V0 Correct / Grounded | Essential Points | Covered | Missing | Incorrect | Completeness (%) | Omission Importance *(Reviewer Judgment)* |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **E014** | What details should an employee provide when requesting planned leave? | 456 | 0.9046 / 0.9547 | 6 | 5 | 1 | 0 | **83.3%** | **Low–Moderate** (omits <5-day late-notice reason / 5-day notice rule) |
| **E015** | How should unexpected absence such as sudden illness be treated? | 1,332 | 0.9561 / 0.9390 | 7 | 7 | 0 | 0 | **100.0%** | **None** |
| **E019** | Does an urgent equipment request automatically authorize a purchase? | 541 | 0.9576 / 0.9312 | 5 | 3 | 2 | 0 | **60.0%** | **Low** (core "No" + independent budget approval covered; missing urgency justification & no-threshold/stock caveats) |
| **E028** | Can the claimant approve an exception for their own expense claim? | 292 | 0.9800 / 0.9844 | 4 | 2 | 2 | 0 | **50.0%** | **Low** (no-self-approval + independent decision maker covered; omits audit record & exception non-bypass limits) |
| **E030** | What should a claimant record when a receipt is missing? | 486 | 0.9646 / 0.9466 | 6 | 4 | 2 | 0 | **66.7%** | **Low–Moderate** (all 4 submission content items covered; omits non-automatic payment/waiver & privacy minimization) |
| **E033** | According to D04, what is the process for reporting a software bug? | 926 | 0.8675 / 0.9027 | 6 | 2 | 4 | 0 | **33.3%** | **High** (covers Section 6 intake fields only; omits triage, 2-hr critical target, escalation, duplicates, Jira confirmation) |
| **E035** | What does D04 say about incident escalation? | 956 | 0.8903 / 0.9096 | 6 | 3 | 3 | 0 | **50.0%** | **High** (omits §9 incident-owner production control, §10 security responder/no-secrets comms, and customer-statement authority) |
| **E038** | What does D07 require at design handoff? | 3,089 | 0.8358 / 0.9076 | 6 | 5 | 1 | 0 | **83.3%** | **Low** (all 7 steps & 7 package elements covered; omits separate budget/Jira/synthetic-example & open-policy caveats) |
| **E039** | What accessibility checks does D07 discuss? | 1,634 | 0.8559 / 0.8710 | 8 | 6 | 2 | 0 | **75.0%** | **Moderate** (all 7 topics & non-certification disclaimer covered; omits Recording Practice anti-fabrication & finding triage) |
| **E040** | How should a UI/UX team member use D07 when transferring designs to Engineering? | 2,311 | 0.8739 / 0.9135 | 7 | 5 | 2 | 0 | **71.4%** | **Low–Moderate** (full 7-step workflow + 7 package elements covered; omits happy-path prototype/synthetic-data warning & separate Finance/Jira boundaries) |

### Aggregate Metrics
- **Mean completeness across the 10 cases:** **67.3%** *(unweighted mean of case percentages; micro-average across all points = **42 / 61 = 68.9%**)*
- **Cases with 100% completeness:** **1 / 10** (`E015`)
- **Cases with High-importance omissions *(Reviewer Judgment)*:** **2 / 10** (`E033`, `E035`, both in D04 Engineering SOP)

---

## 3. Case-by-Case Checklists & Supporting Evidence

*(Source-supported chunk locations from `chatbot_response.context` are cited for each essential point; V0 scores reflect exact text comparison.)*

### E014 — Planned leave request details (`company_policy` | `engineering`)
- **Golden query:** `What details should an employee provide when requesting planned leave?`
- **Retrieved evidence limitation *(source-supported)*:** D02 does not prescribe a specific software application, form schema, formal reporting channel, or submission time-of-day cutoff (`Chunk 1`, `Chunk 4`).

| # | Essential Policy Point *(Question + Context)* | Supporting Chunk(s) | V0 Status | Notes |
| :---: | :--- | :--- | :---: | :--- |
| 1 | Record requester identity (who is making the request). | `Chunk 1` (§4 Step 1) | **Covered** | Explicitly listed in step 1. |
| 2 | Specify intended first and last absence dates accurately. | `Chunk 1` (§4 Step 1), `Chunk 3` (§6) | **Covered** | Explicitly stated. |
| 3 | Provide an appropriate absence description. | `Chunk 1` (§4 Step 1) | **Covered** | Explicitly stated. |
| 4 | Identify work handover or coverage implications. | `Chunk 1` (§4 Step 1), `Chunk 6` (§8) | **Covered** | Explicitly stated. |
| 5 | Omit confidential medical details from general shared channels. | `Chunk 1` (§4 Step 1), `Chunk 6` (§7.2) | **Covered** | Included as an explicit note. |
| 6 | Meet the 5-business-day notice rule, or state the reason for shorter notice and request discretionary exception review. | `Chunk 1` (§4 Step 2 & §4.1), `Chunk 2` (§2), `Chunk 5` (§5), `Chunk 7` | **Missing** | Omitted; matters if the employee is submitting closer than 5 business days before leave. |

- **V0 Completeness:** **5 / 6 (83.3%)** — **Omission Importance *(Reviewer Judgment)*:** Low–Moderate.

---

### E015 — Unexpected absence procedure (`company_policy` | `engineering`)
- **Golden query:** `How should unexpected absence such as sudden illness be treated?`
- **Retrieved evidence limitation *(source-supported)*:** Exact reporting deadline, formal channel name, leave quotas, paid/unpaid rules, and proof requirements are unapproved in D02 (`Chunk 1`, `Chunk 6`).

| # | Essential Policy Point *(Question + Context)* | Supporting Chunk(s) | V0 Status | Notes |
| :---: | :--- | :--- | :---: | :--- |
| 1 | Treat unexpected absence (e.g., sudden illness, family emergency) as warranting exception review, not an automatic entitlement or leave category. | `Chunk 2` (§2), `Chunk 3` (§5), `Chunk 5` (§5), `Chunk 6` (§10–11) | **Covered** | Covered in intro and closing caveat. |
| 2 | Notify HR or authorized leave contact through an approved channel as soon as reasonably practicable. | `Chunk 1` (§5.1), `Chunk 6` (§10) | **Covered** | Step 1 covers prompt approved-route notification. |
| 3 | Minimize shared details (only scheduling/exception info; avoid confidential medical detail in general channels). | `Chunk 1` (§5.1), `Chunk 3`, `Chunk 4` (§7.2) | **Covered** | Explicitly noted in step 1. |
| 4 | Identify expected absence period where known and update if circumstances change. | `Chunk 1` (§5.1) | **Covered** | Step 2 covers both period and updates. |
| 5 | Flag urgent work continuity needs without sharing passwords or restricted materials. | `Chunk 1` (§5.1), `Chunk 4` (§8) | **Covered** | Step 2 preserves credential and access boundaries. |
| 6 | Submit or complete the exception record when able so the approver can decide. | `Chunk 1` (§5.1) | **Covered** | Step 3 covers exception record completion. |
| 7 | Exception is evaluated by HR custodian or explicitly delegated approver; self-approval is prohibited and no quotas/proof rules are created. | `Chunk 1` (§5.2), `Chunk 2` (§2), `Chunk 5` (§5), `Chunk 6` (§10–11) | **Covered** | Step 4 and final paragraph cover independent approval, no self-approval, and non-entitlement scope. |

- **V0 Completeness:** **7 / 7 (100.0%)** — **Omission Importance *(Reviewer Judgment)*:** None.

---

### E019 — Urgent equipment request (`company_policy` | `engineering`)
- **Golden query:** `Does an urgent equipment request automatically authorize a purchase?`
- **Retrieved evidence limitation *(source-supported)*:** D08 defines no monetary approval threshold, purchasing approval matrix, vendor workflow, or per-person device allowance (`Chunk 2`, `Chunk 3`, `Chunk 5`).

| # | Essential Policy Point *(Question + Context)* | Supporting Chunk(s) | V0 Status | Notes |
| :---: | :--- | :--- | :---: | :--- |
| 1 | Direct answer: No — an urgent equipment request does not automatically authorize a purchase or create an entitlement. | `Chunk 1` (§1), `Chunk 3` (§5), `Chunk 7` (§7) | **Covered** | Answered unambiguously in sentence 1. |
| 2 | Employee with a genuinely time-sensitive need must explain the operational harm caused by delay / reason for urgency to seek an urgent exception. | `Chunk 2` (§5), `Chunk 6` (§3.2) | **Missing** | Mentions urgent exception exists, but omits how the employee justifies it (explaining operational harm). |
| 3 | Operations Manager (custodian) or expressly delegated eligible approver evaluates the exception; self-approval is prohibited. | `Chunk 2` (§5) | **Covered** | Explicitly covered. |
| 4 | A separate independent budget/purchasing authorization is still required; urgency or a policy exception cannot bypass or substitute for it. | `Chunk 1`, `Chunk 3` (§5), `Chunk 5`, `Chunk 7` | **Covered** | Explicitly covered. |
| 5 | Even an approved exception does not create inventory/stock, define a monetary threshold, override security/access rules, or authorize AI/Jira tool actions. | `Chunk 2` (§4), `Chunk 3` (§5), `Chunk 4` (§7), `Chunk 5` | **Missing** | Omits stock availability/no-threshold/security & AI-action boundaries. |

- **V0 Completeness:** **3 / 5 (60.0%)** — **Omission Importance *(Reviewer Judgment)*:** Low.

---

### E028 — Expense exception authorization (`company_policy` | `engineering`)
- **Golden query:** `Can the claimant approve an exception for their own expense claim?`
- **Retrieved evidence limitation *(source-supported)*:** Specific ordinary approval ladder and delegation matrix are unresolved in D10 (`Chunk 8` §9).

| # | Essential Policy Point *(Question + Context)* | Supporting Chunk(s) | V0 Status | Notes |
| :---: | :--- | :--- | :---: | :--- |
| 1 | Direct answer: No — a claimant (or requester, editor, Copilot) cannot authorize an exception for their own expense claim. | `Chunk 1` (§6), `Chunk 2` (§2), `Chunk 4` (D01 §12), `Chunk 6` | **Covered** | Clearly stated. |
| 2 | Must be decided by an eligible Finance policy custodian or explicitly delegated authorized approver independent of the requester. | `Chunk 1` (§6), `Chunk 2` (§2), `Chunk 4` (D01 §12), `Chunk 5` (§5) | **Covered** | Explicitly stated. |
| 3 | Exception request, explanation/reason, independent decision maker, and outcome must be recorded in the authorized audit process. | `Chunk 1` (§6), `Chunk 4` (D01 §12) | **Missing** | Audit/documentation requirement omitted. |
| 4 | Even an approved exception cannot override document permissions, `> ₹5,000` additional Finance review, separate budget approval, or guarantee reimbursement. | `Chunk 1` (§6), `Chunk 4` (D01 §12), `Chunk 5` (§5) | **Missing** | Safeguard boundaries omitted. |

- **V0 Completeness:** **2 / 4 (50.0%)** — **Omission Importance *(Reviewer Judgment)*:** Low.

---

### E030 — Missing receipt procedure (`company_policy` | `engineering`)
- **Golden query:** `What should a claimant record when a receipt is missing?`
- **Retrieved evidence limitation *(source-supported)*:** D10 intentionally leaves the exact rule at `₹500` and acceptable substitute proof unapproved (`Chunk 1`, `Chunk 3`, `Chunk 7`, `Chunk 8`).

| # | Essential Policy Point *(Question + Context)* | Supporting Chunk(s) | V0 Status | Notes |
| :---: | :--- | :--- | :---: | :--- |
| 1 | State which proof/receipt is absent and why it is unavailable (without erasing records or inventing a receipt). | `Chunk 2` (§4), `Chunk 4` (§6), `Chunk 6` (D01 §6) | **Covered** | Explicitly covered. |
| 2 | Record what alternative evidence exists. | `Chunk 4` (§6) | **Covered** | Explicitly covered. |
| 3 | Record business purpose, amounts involved, and any inconsistent amounts or currency conversions. | `Chunk 2` (§4), `Chunk 4` (§6) | **Covered** | Explicitly covered. |
| 4 | Record the requested deviation and explicitly request a limited auditable missing-receipt exception. | `Chunk 1`, `Chunk 2` (§4), `Chunk 4` (§6), `Chunk 6`, `Chunk 7` | **Covered** | Explicitly covered. |
| 5 | Note non-waiver & approval safeguards: exception does not guarantee payment or waive `₹5,000` additional Finance review / independent approval (no self-approval). | `Chunk 1`, `Chunk 2` (§4), `Chunk 4` (§6), `Chunk 6`, `Chunk 7` | **Missing** | Omitted; claimant may assume exception automatically clears payment. |
| 6 | Apply data minimization: share only necessary review details and avoid unnecessary personal/third-party identifiers. | `Chunk 2` (§4), `Chunk 3` (§1) | **Missing** | Privacy minimization omitted. |

- **V0 Completeness:** **4 / 6 (66.7%)** — **Omission Importance *(Reviewer Judgment)*:** Low–Moderate.

---

### E033 — Actionable Engineering bug report (`department_policy` | `engineering`)
- **Golden query:** `According to D04, what is the process for reporting a software bug?`
- **Retrieved evidence limitation *(source-supported)*:** D04 leaves the final severity rubric/classifier, formal reporting channel, triage clock-start event, and Jira field schema unapproved (`Chunk 1`, `Chunk 2` §7, `Chunk 4` §14, `Chunk 5`).

| # | Essential Policy Point *(Question + Context)* | Supporting Chunk(s) | V0 Status | Notes |
| :---: | :--- | :--- | :---: | :--- |
| 1 | Distinguish bug vs. incident (not every bug or ticket automatically declares an incident). | `Chunk 2` (§6), `Chunk 5` (§9) | **Missing** | Omitted. |
| 2 | Record all 6 actionable intake fields: identity/context, expected vs. actual, reproduction steps/frequency ("unknown" if needed), business impact, sanitized evidence, tracking. | `Chunk 2` (§6 table) | **Covered** | All 6 rows reproduced accurately. |
| 3 | Protect sensitive evidence: minimize customer IDs/secrets and reference access-controlled logs/screenshots rather than duplicating into broad chats/tickets. | `Chunk 2` (§5–§6) | **Covered** | Covered via sanitized evidence accessible only to approved recipients. |
| 4 | Check authorized issue records for duplicates and clarify ambiguity without claiming inaccessible private tickets exist. | `Chunk 5` (§8) | **Missing** | Only lists "related/duplicate issues" as a field; omits §8 search/access rule. |
| 5 | Post-intake triage & escalation workflow: authorized responder validates completeness/reproducibility, assesses priority without inferring "critical" from "urgent", targets **2 operational business hours** for critical triage (not fix), and escalates safely if needed. | `Chunk 1` (§2), `Chunk 2` (§7 Steps 1–4), `Chunk 5` (§7.1) | **Missing** | **Major gap:** entire Section 7 triage & escalation workflow omitted. |
| 6 | Copilot Jira safeguard: if drafting an Engineering bug ticket via Copilot/Activepieces, drafting is not creation and requires explicit user post-draft confirmation and separate action authorization. | `Chunk 1` (§2), `Chunk 3` (§12), `Chunk 4` | **Missing** | Section 12 drafting vs. creation safeguard omitted. |

- **V0 Completeness:** **2 / 6 (33.3%)** — **Omission Importance *(Reviewer Judgment)*:** **High** (answer stops at Section 6 intake fields and omits what happens next in the reporting process).

---

### E035 — Engineering incident escalation (`department_policy` | `engineering`)
- **Golden query:** `What does D04 say about incident escalation?`
- **Retrieved evidence limitation *(source-supported)*:** Incident command authority, formal communication/reporting channels, and customer-notification cadence remain unapproved in D04 (`Chunk 2` §10/11, `Chunk 5` §14).

| # | Essential Policy Point *(Question + Context)* | Supporting Chunk(s) | V0 Status | Notes |
| :---: | :--- | :--- | :---: | :--- |
| 1 | Escalation triggers during triage: escalate via approved channel to authorized engineering/incident owner when owner is unavailable, material security/privacy risk exists, or service deteriorates; no auto-rights granted. | `Chunk 4` (§7 Step 4) | **Covered** | Explicitly covered (point 2). |
| 2 | Coordinated 5-step incident response & owner authority: detection/registration, coordination, assessment/containment, recovery/verification, follow-up — authorized Engineering incident owner approves production actions (ticket != rollback/deploy approval). | `Chunk 3` (§9 Steps 1–5) | **Missing** | **Major gap:** entire Section 9 incident response and production-action boundary omitted. |
| 3 | Security/privacy escalation boundary: alert an authorized security responder via approved route and never place secrets, customer records, or restricted extracts into broad incident comms. | `Chunk 3` (§10 table), `Chunk 4` (§5) | **Missing** | Security responder route and anti-secret comms boundary omitted. |
| 4 | Distinguish high-priority project risk escalation (**1 business day** target) from critical-bug triage (**2 operational business hours** target). | `Chunk 1` (§2), `Chunk 2` (§10/11), `Chunk 3`, `Chunk 4` | **Covered** | Explicitly covered (point 1). |
| 5 | Customer-facing statement & exception controls: customer statements require communications authority; critical incidents may warrant auditable exception by Engineering Manager/delegate (no self-approval or permission/deployment bypass). | `Chunk 2` (§10/11) | **Covered** *(mostly)* | Exception handling covered; omits customer-facing statement authority note. |
| 6 | Unapproved command/cadence & Copilot boundaries: incident command authority, escalation channel, and cadence are unresolved (`Chunk 5`); Copilot incident-escalation/Jira suggestions cannot auto-submit without review and confirmation (`Chunk 2` §12). | `Chunk 2` (§12), `Chunk 5` (§14) | **Missing** | Unresolved rules & Jira-suggestion boundary omitted. |

- **V0 Completeness:** **3 / 6 (50.0%)** — **Omission Importance *(Reviewer Judgment)*:** **High**.

---

### E038 — UI/UX design handoff package (`department_policy` | `uiux`)
- **Golden query:** `What does D07 require at design handoff?`
- **Retrieved evidence limitation *(source-supported)*:** Binding WCAG standard/threshold, browser/device matrix, final acceptance/sign-off authority, handoff SLA, and canonical design repository/retention remain unapproved (`Chunk 1`, `Chunk 2`, `Chunk 3`, `Chunk 8`).

| # | Essential Policy Point *(Question + Context)* | Supporting Chunk(s) | V0 Status | Notes |
| :---: | :--- | :--- | :---: | :--- |
| 1 | Package precision & recipient access control: package must distinguish intended behavior from gaps using only material each recipient is authorized to view. | `Chunk 1` (§2), `Chunk 4` (§6), `Chunk 8` (§4) | **Covered** | Explicitly stated. |
| 2 | Include all 7 required handoff-package content elements: scope/revision, screens/flows (all states), interaction behavior, content/labels, layout/assets, accessibility evidence, handoff decisions. | `Chunk 8` (§4 table) | **Covered** | All 7 categories and sub-items covered. |
| 3 | Review, feasibility & ownership workflow: share current version, seek UI/UX/Product/Engineering review, evaluate feasibility/dependencies, categorize findings & ownership, disposition unresolved concerns. | `Chunk 4` (§6 Steps 1–5) | **Covered** | Steps 1–5 covered in detail. |
| 4 | Communicate handoff state & enforce non-approval boundaries: report version/blockers/recipients/next step; never claim "approved for development", "accessibility passed", or "ready to release" without authority — handoff != release/launch approval. | `Chunk 1` (§2), `Chunk 4` (§6 Step 6) | **Covered** | Explicitly covered. |
| 5 | Post-handoff change tracking: log revision identifier/reason/rework/affected components and notify eligible reviewers instead of leaving obsolete links. | `Chunk 3` (§2), `Chunk 4` (§6 Step 7), `Chunk 8` (§4) | **Covered** | Explicitly covered. |
| 6 | Governance & prototype safeguards: mark happy-path prototype gaps, use sanitized/synthetic examples for sensitive screens, obtain separate Finance/budget approval if needed, note Jira post-draft confirmation and unapproved WCAG/sign-off/SLA parameters. | `Chunk 2` (§9), `Chunk 4` (§6 end), `Chunk 7` (§8), `Chunk 8` (§4) | **Missing** | Governance caveats omitted after detailed step/content listing. |

- **V0 Completeness:** **5 / 6 (83.3%)** — **Omission Importance *(Reviewer Judgment)*:** Low.

---

### E039 — Accessibility checks (`department_policy` | `uiux`)
- **Golden query:** `What accessibility checks does D07 discuss?`
- **Retrieved evidence limitation *(source-supported)*:** D07 adopts no binding WCAG edition/level, numerical contrast/pass threshold, device/assistive-tech matrix, formal sign-off role, or blanket accessibility waiver (`Chunk 4` §2, `Chunk 5` §7, `Chunk 6` §9, `Chunk 8` §5).

| # | Essential Policy Point *(Question + Context)* | Supporting Chunk(s) | V0 Status | Notes |
| :---: | :--- | :--- | :---: | :--- |
| 1 | Keyboard operation & visible focus order + Labels, semantics, names, headings/landmarks. | `Chunk 2` (§5), `Chunk 8` (§5) | **Covered** | Both topics explicitly listed. |
| 2 | Text, graphics, non-text alternatives, contrast & not conveying meaning by color alone. | `Chunk 2` (§5) | **Covered** | Explicitly listed. |
| 3 | Forms, required fields, validation errors, correction steps & status updates + Motion, animations, time-sensitive interactions & user control/feedback. | `Chunk 2` (§5) | **Covered** | Both topics explicitly listed. |
| 4 | Responsive layout, supported viewport scaling & zoom behavior without losing critical controls. | `Chunk 2` (§5) | **Covered** | Explicitly listed. |
| 5 | Assistive technology & testing: document which combinations were tested, by whom, results, and which were untested. | `Chunk 2` (§5) | **Covered** | Explicitly listed. |
| 6 | Non-certification framing: practical review topics only — not WCAG conformance certification, numerical thresholds, release gates, or waiver authority. | `Chunk 4`, `Chunk 5`, `Chunk 6`, `Chunk 8` (§5) | **Covered** | Explicitly stated in closing summary. |
| 7 | Mandatory Recording Practice: record design version, environment, steps, evidence, follow-up, and `verified` / `requires investigation` / `not evaluated` status; never turn "not tested" into "passes" or fabricate contrast/test results. | `Chunk 2` (§5 Recording practice) | **Missing** | Recording states & anti-fabrication guardrails omitted. |
| 8 | Production issue triage & disagreements: distinguish design finding vs. Engineering bug vs. incident vs. future project risk, and record disagreements without self-certifying compliance. | `Chunk 2` (§5 end), `Chunk 7` (§7) | **Missing** | Issue classification and disagreement handling omitted. |

- **V0 Completeness:** **6 / 8 (75.0%)** — **Omission Importance *(Reviewer Judgment)*:** Moderate.

---

### E040 — UI/UX design-to-Engineering handoff (`department_policy` | `uiux`)
- **Golden query:** `How should a UI/UX team member use D07 when transferring designs to Engineering?`
- **Retrieved evidence limitation *(source-supported)*:** Canonical repository, revision-numbering scheme, mandatory acceptance template, turnaround SLA, WCAG conformance target, and final sign-off authority are unapproved (`Chunk 1`, `Chunk 2`, `Chunk 4`, `Chunk 8`).

| # | Essential Policy Point *(Question + Context)* | Supporting Chunk(s) | V0 Status | Notes |
| :---: | :--- | :--- | :---: | :--- |
| 1 | Prepare an implementable, permission-safe package covering the 7 handoff elements (scope/revision, screens/flows, interactions, content/labels, layout/assets, accessibility evidence, handoff decisions) using only material recipients may access. | `Chunk 3` (§6 Step 1), `Chunk 8` (§4) | **Covered** | Steps 1–2 explicitly cover both access scope and all 7 elements. |
| 2 | Avoid false completeness signals on happy-path prototypes (flag missing error/permission-denied/keyboard states) and use sanitized/synthetic examples rather than real customer/restricted records. | `Chunk 8` (§4) | **Missing** | Mentions distinguishing intended behavior from gaps, but omits happy-path prototype and synthetic-data rules. |
| 3 | Request UI/UX, eligible Product, and Engineering review (minimum-necessary sharing) and discuss implementation feasibility/dependencies. | `Chunk 3` (§6 Steps 2–3) | **Covered** | Covered in steps 3–4. |
| 4 | Record findings/ownership (design vs. Product vs. Engineering vs. access) and disposition unresolved concerns without silently assuming acceptance; escalate material risk. | `Chunk 3` (§6 Steps 4–5) | **Covered** | Covered in steps 5–6. |
| 5 | Communicate handoff state (version, reviewed items, blockers, recipients, next step) and never state "approved for development", "accessibility passed", or "ready to release" without authority/evidence. | `Chunk 1`, `Chunk 3` (§6 Step 6) | **Covered** | Covered in step 7. |
| 6 | Handle post-handoff changes traceably (revised version, affected components, reason, rework, renewed reviewer input) rather than leaving obsolete conflicting links. | `Chunk 2`, `Chunk 3` (§6 Step 7), `Chunk 8` | **Covered** | Covered in step 8. |
| 7 | Keep separate gates distinct (design handoff != Product prioritization, Finance budget approval, launch approval, or Jira creation without draft confirmation) and disclose D07's unapproved authorities/targets. | `Chunk 1` (§1), `Chunk 2` (§3), `Chunk 3` (§6 end), `Chunk 4` (§9), `Chunk 5` (§8) | **Missing** | Separate Finance/Product/Jira and unapproved-authority caveats omitted. |

- **V0 Completeness:** **5 / 7 (71.4%)** — **Omission Importance *(Reviewer Judgment)*:** Low–Moderate.

---

## 4. Top Three Recurring Omission Patterns *(Reviewer Judgment)*

1. **First-section / single-table stopping in multi-stage workflows (`E033`, `E035`, `E014`):** V0 consistently extracts the most directly matching list or table accurately (`E033` D04 §6 bug-intake table; `E014` D02 §4 Step 1 fields) and then stops without pulling downstream process rules from adjacent sections in retrieved context (such as `E033` Section 7 triage & 2-hour critical target, `E035` Section 9 incident response steps, or `E014` Section 4.1 late-notice justification). Notably, `E033` (`926` chars) and `E035` (`956` chars) were well below V0's `1,800`-character guidance, showing this is an extraction/synthesis-scope behavior rather than a hard character cutoff.
2. **Omitting downstream operational safeguards and non-bypass limits (`E019`, `E028`, `E030`, `E038`, `E040`):** After delivering the direct answer or main checklist, V0 frequently omits companion boundaries from the same documents — such as audit-trail recording (`E028`), non-waiver of `> ₹5,000` Finance review or independent budget approvals (`E019`, `E028`, `E030`, `E038`, `E040`), and privacy/synthetic-data requirements (`E030`, `E040`).
3. **Omitting recording rules and explicit unresolved-policy boundaries (`E033`, `E035`, `E039`, `E040`):** V0 tends to preserve explicit disclaimers when asked directly about checks (`E039` no-WCAG-certification disclaimer), yet drops procedural recording controls (`E039` Section 5 `verified` / `requires investigation` / `not evaluated` states and anti-fabrication rule), unresolved governance ownership (`E035` unapproved incident command/cadence), and AI-action boundaries (`E033`, `E035` Jira draft-before-creation confirmation).

---

## 5. Product & Prompt Recommendation *(Reviewer Judgment)*

**Recommendation: Retain V0 unchanged in production for now, and target any follow-up improvement specifically at multi-section workflow coverage (`E033`, `E035`) rather than raising global character limits.**

- **Why retain V0 now:** V0 achieved `50/50 PASS` with zero errors, zero hallucinations (`0` incorrect points across all 10 cases reviewed), `4.19s` P95 latency, and high actionability on core leave, expense, and UI/UX handoff questions (`E015` 100%, `E014` 83.3%, `E038` 83.3%, `E039` 75.0%, `E040` 71.4%).
- **Why global length expansion is the wrong lever:** WP9.31–WP9.33 showed that loosening the global length target (`V1`) regressed portfolio quality (`50/50` → `48/50`), slowed P95 latency (`4.19s` → `4.82s`), and triggered an `answer_length_exceeded` refusal on `E040`, while the worst completeness gaps (`E033` at `33.3%`, `E035` at `50.0%`) used fewer than `1,000` characters under V0.
- **Targeted next investigation (when authorized):** Inspect why D04 workflow queries (`E033`, `E035`) stop after one subsection despite multi-section chunks being present (`17,632` chars retrieved), and decide whether completeness scoring should become a standard diagnostic metric on high-risk procedural queries.
