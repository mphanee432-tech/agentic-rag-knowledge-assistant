# WP9.36 — Rebaselined Manual V0 Answer Completeness Baseline

> **Method Attribution:** This is a **manual, evidence-based baseline assessment** derived strictly by inspecting `enterprise_golden_50.json`, saved V0 answers and retrieved `chatbot_response.context` chunks in `prompt_experiments/v0_results.json`, `prompt_experiments/wp9_34_completeness_review.md`, and WP9.35 checklist validations for `E033` and `E035`. It is **not** an independent human evaluation or an automated metric.

---

## 1. Purpose & Refinement Rules

Following WP9.34 and WP9.35, the 10-case completeness rubric was tightened so that each checklist includes **only points directly required to answer the exact golden question and fulfill the employee's requested task** from the authorized retrieved evidence:
- **Removed:** Secondary or adjacent cross-policy rules (such as Activepieces/Jira drafting workflows when the question asks about bug reporting, incident escalation, or equipment/design policies; document-access permissions when asking about expense self-approval; and post-incident learning or production dispute escalation outside the asked scope).
- **Retained:** All genuinely essential workflow steps, conditions, quantitative targets, and operational safeguards (for example, D04 `§7` triage & 2-hour critical target on `E033`; D04 `§9–§10` incident-owner production control, no-secrets incident comms, and customer-statement authority on `E035`; `> ₹5,000` Finance review & no-self-approval safeguards on `E028`/`E030`; D07 `§5` Recording Practice on `E039`; D07 `§4` happy-path prototype/synthetic-data safeguards on `E038`/`E040`).
- **Scoring:** Equal weighting per case (`Covered / Total Applicable Essential Points * 100`), reported alongside the point-level micro-average across all 10 cases. No points were contradicted/incorrect (`Incorrect = 0`).

---

## 2. Old (WP9.34) vs. Revised (WP9.36) Completeness Summary

| Case ID | Golden Question | WP9.34 Score | Revised WP9.36 Score | Missing / Total (WP9.36) | Summary of Checklist Change |
| :--- | :--- | :---: | :---: | :---: | :--- |
| **E014** | What details should an employee provide when requesting planned leave? | 5/6 (**83.3%**) | **5/6 (83.3%)** | 1 / 6 | Refined point 6 strictly to conditional late-request reason (`< 5` business days); score unchanged. |
| **E015** | How should unexpected absence such as sudden illness be treated? | 7/7 (**100.0%**) | **7/7 (100.0%)** | 0 / 7 | Unchanged — all 7 points are essential D02 unexpected-absence steps/rules. |
| **E019** | Does an urgent equipment request automatically authorize a purchase? | 3/5 (**60.0%**) | **3/4 (75.0%)** | 1 / 4 | Removed unrelated AI/Jira & security-override clauses from point 5 and secondary urgency-harm field drafting detail; retained no-threshold/stock-creation safeguard. |
| **E028** | Can the claimant approve an exception for their own expense claim? | 2/4 (**50.0%**) | **2/3 (66.7%)** | 1 / 3 | Removed unrelated document-permission clause; merged auditability & `> ₹5,000` Finance/budget/payment non-waiver limits into one safeguard point. |
| **E030** | What should a claimant record when a receipt is missing? | 4/6 (**66.7%**) | **4/6 (66.7%)** | 2 / 6 | Unchanged — all 6 points govern what to record/omit (`§4`, `§6`) and what that record does not auto-approve. |
| **E033** | According to D04, what is the process for reporting a software bug? | 2/6 (**33.3%**) | **2/4 (50.0%)** | 2 / 4 | Removed out-of-scope Copilot Jira ticket drafting (`§12`) and standalone bug-vs.-incident definition nuance; retained `§7` triage/2-hr target/escalation and `§8` duplicate-record check. |
| **E035** | What does D04 say about incident escalation? | 3/6 (**50.0%**) | **2/5 (40.0%)** | 3 / 5 | Removed out-of-scope Copilot Jira ticket confirmation (`§12`) & post-incident follow-up (`§9` Step 5); separated covered exception handling from missed customer-comms authority so the 3 missing `Chunk 2`/`3`/`5` points are scored accurately. |
| **E038** | What does D07 require at design handoff? | 5/6 (**83.3%**) | **5/6 (83.3%)** | 1 / 6 | Tightened point 6 by removing unrelated Finance budget and Jira draft clauses while keeping `§4` happy-path prototype gaps & synthetic-data rules. |
| **E039** | What accessibility checks does D07 discuss? | 6/8 (**75.0%**) | **6/7 (85.7%)** | 1 / 7 | Removed downstream production bug/disagreement triage (`§7`); retained all 7 topics, non-certification framing, and `§5` Recording Practice. |
| **E040** | How should a UI/UX team member use D07 when transferring designs to Engineering? | 5/7 (**71.4%**) | **5/6 (83.3%)** | 1 / 6 | Removed unrelated Finance budget and Jira confirmation cross-gates already separated by D07 Step 6's non-approval warning; retained `§4` prototype/synthetic-data gap. |

### Baseline Aggregates (`N = 10` Complex Procedural Cases)
- **Mean case-level completeness:** **73.4%** *(up from WP9.34 **67.3%**)*
- **Point-level micro-average completeness:** **41 / 54 (75.9%)** *(up from WP9.34 **42 / 61 = 68.9%**)*
- **Cases with 100% completeness:** **1 / 10** (`E015`)
- **Cases with Incorrect points:** **0 / 54**

---

## 3. Case-by-Case Rebaselined Checklists

### E014 — `What details should an employee provide when requesting planned leave?` (`5/6 = 83.3%`)
*Change reason vs. WP9.34:* Refined point 6 strictly to the conditional details required when submitting closer than 5 business days ahead (`Chunk 1` §4.1); submission channel/time-of-day cutoff remain unapproved (`Chunk 1`, `Chunk 4`).

| # | Essential Point | Supporting Chunk(s) | V0 Status |
| :---: | :--- | :--- | :---: |
| 1 | Requester identity | `Chunk 1` (§4 Step 1) | **Covered** |
| 2 | Intended first and last absence dates | `Chunk 1` (§4 Step 1), `Chunk 3` (§6) | **Covered** |
| 3 | Appropriate absence description | `Chunk 1` (§4 Step 1) | **Covered** |
| 4 | Handover or coverage implications | `Chunk 1` (§4 Step 1), `Chunk 6` (§8) | **Covered** |
| 5 | Exclude confidential medical detail from general shared channels | `Chunk 1` (§4 Step 1), `Chunk 6` (§7.2) | **Covered** |
| 6 | If unable to meet 5-business-day notice, state reason for shorter notice and request exception review | `Chunk 1` (§4.1), `Chunk 2`, `Chunk 5` | **Missing** |

### E015 — `How should unexpected absence such as sudden illness be treated?` (`7/7 = 100.0%`)
*Change reason vs. WP9.34:* Unchanged — all 7 points remain required; reporting deadline/channel and proof requirements remain unapproved (`Chunk 1`, `Chunk 6`).

| # | Essential Point | Supporting Chunk(s) | V0 Status |
| :---: | :--- | :--- | :---: |
| 1 | Exception review framing, not automatic entitlement/approval | `Chunk 2`, `Chunk 3`, `Chunk 5`, `Chunk 6` | **Covered** |
| 2 | Notify HR or authorized leave contact via approved channel ASAP | `Chunk 1` (§5.1), `Chunk 6` (§10) | **Covered** |
| 3 | Minimize shared data; keep confidential medical details out of general channels | `Chunk 1`, `Chunk 3`, `Chunk 4` (§7.2) | **Covered** |
| 4 | Identify expected absence period where known and update if changed | `Chunk 1` (§5.1) | **Covered** |
| 5 | Identify continuity needs without sharing passwords or restricted materials | `Chunk 1` (§5.1), `Chunk 4` (§8) | **Covered** |
| 6 | Submit or complete the exception record when able | `Chunk 1` (§5.1) | **Covered** |
| 7 | HR custodian or delegated approver evaluates; no self-approval and no quotas created | `Chunk 1` (§5.2), `Chunk 2`, `Chunk 5`, `Chunk 6` | **Covered** |

### E019 — `Does an urgent equipment request automatically authorize a purchase?` (`3/4 = 75.0%`)
*Change reason vs. WP9.34:* Removed unrelated AI/Jira and security-access permissions and secondary operational-harm drafting field detail (`Chunk 2`, `Chunk 4`) because the question asks specifically about purchase authorization; kept D08's no-stock/no-threshold caveat (`Chunk 2`, `Chunk 3`).

| # | Essential Point | Supporting Chunk(s) | V0 Status |
| :---: | :--- | :--- | :---: |
| 1 | No — an urgent equipment request does not automatically authorize a purchase or create an entitlement | `Chunk 1`, `Chunk 3` (§5), `Chunk 7` (§7) | **Covered** |
| 2 | Operations Manager (custodian) or delegated eligible approver evaluates an urgent exception; no self-approval | `Chunk 2` (§5) | **Covered** |
| 3 | Separate independent budget/purchasing authorization is still required; urgency/exception cannot substitute | `Chunk 1`, `Chunk 3` (§5), `Chunk 5`, `Chunk 7` | **Covered** |
| 4 | Urgency/exception does not create inventory or define a monetary purchasing threshold/matrix in D08 | `Chunk 2` (§4), `Chunk 3` (§5), `Chunk 5` | **Missing** |

### E028 — `Can the claimant approve an exception for their own expense claim?` (`2/3 = 66.7%`)
*Change reason vs. WP9.34:* Removed unrelated document-access permission clause and merged standalone audit-field detail into the core exception non-bypass safeguard (`Chunk 1` §6, `Chunk 4` D01 §12).

| # | Essential Point | Supporting Chunk(s) | V0 Status |
| :---: | :--- | :--- | :---: |
| 1 | No — a claimant cannot approve or authorize an exception for their own expense claim | `Chunk 1`, `Chunk 2`, `Chunk 4`, `Chunk 6` | **Covered** |
| 2 | Must be decided by an independent eligible Finance custodian or explicitly delegated authorized approver | `Chunk 1`, `Chunk 2`, `Chunk 4`, `Chunk 5` | **Covered** |
| 3 | Exception must be audited and cannot waive `> ₹5,000` Finance review, separate budget approval, or guarantee reimbursement | `Chunk 1` (§6), `Chunk 4` (D01 §12), `Chunk 5` (§5) | **Missing** |

### E030 — `What should a claimant record when a receipt is missing?` (`4/6 = 66.7%`)
*Change reason vs. WP9.34:* Unchanged — all 6 points specify what to record/avoid recording and prevent misinterpreting the missing-receipt record as guaranteed payment (`₹500` exact boundary and acceptable substitutes remain unapproved [`Chunk 1`, `Chunk 3`, `Chunk 7`]).

| # | Essential Point | Supporting Chunk(s) | V0 Status |
| :---: | :--- | :--- | :---: |
| 1 | State which proof is absent and why unavailable (without manufacturing evidence) | `Chunk 2` (§4), `Chunk 4` (§6), `Chunk 6` | **Covered** |
| 2 | State what alternative evidence exists | `Chunk 4` (§6) | **Covered** |
| 3 | Record business purpose, amounts involved, and inconsistent amounts/currency conversions | `Chunk 2` (§4), `Chunk 4` (§6) | **Covered** |
| 4 | State requested deviation and request a documented exception | `Chunk 1`, `Chunk 2`, `Chunk 4`, `Chunk 6`, `Chunk 7` | **Covered** |
| 5 | Exception is not automatic waiver/payment and remains subject to independent approval and `> ₹5,000` Finance review | `Chunk 1`, `Chunk 2`, `Chunk 4`, `Chunk 6`, `Chunk 7` | **Missing** |
| 6 | Data minimization: share only necessary info and omit unnecessary personal/third-party identifiers | `Chunk 2` (§4), `Chunk 3` (§1) | **Missing** |

### E033 — `According to D04, what is the process for reporting a software bug?` (`2/4 = 50.0%`)
*Change reason vs. WP9.34:* Per WP9.35 Step 1, removed Copilot/Activepieces Jira confirmation (`§12`, out of scope for bug-reporting process) and standalone bug-vs.-incident definition nuance (`§6` prose); retained `§7` triage/critical SLA/escalation and `§8` duplicate-check boundaries (`Chunk 2`, `Chunk 5`).

| # | Essential Point | Supporting Chunk(s) | V0 Status |
| :---: | :--- | :--- | :---: |
| 1 | Record the 6 actionable bug-intake fields (identity/context, expected vs. actual, reproduction/"unknown", impact, sanitized evidence, tracking) | `Chunk 2` (§6 table) | **Covered** |
| 2 | Protect sensitive data (sanitize logs/screenshots; limit access to approved recipients) | `Chunk 2` (§5–§6) | **Covered** |
| 3 | Check only authorized issue records for duplicates and clarify ambiguity without asserting inaccessible private tickets | `Chunk 5` (§8) | **Missing** |
| 4 | Post-intake responder triage & escalation: validate completeness/reproducibility, avoid inferring "critical" from "urgent", target `2` operational business hours for critical triage (not fix), and escalate safely | `Chunk 1` (§2), `Chunk 2` (§7 Steps 1–4), `Chunk 5` (§7.1) | **Missing** |

### E035 — `What does D04 say about incident escalation?` (`2/5 = 40.0%`)
*Change reason vs. WP9.34:* Per WP9.35 Step 1, removed Copilot Jira confirmation (`§12`) and post-incident learning (`§9` Step 5); separated covered exception approval from missed customer-communications/unapproved-command boundaries (`Chunk 2`, `Chunk 3`, `Chunk 5`).

| # | Essential Point | Supporting Chunk(s) | V0 Status |
| :---: | :--- | :--- | :---: |
| 1 | Bug-intake escalation triggers (owner unavailable, security/privacy risk, service deterioration) via approved channel; no auto-rights | `Chunk 4` (§7 Step 4) | **Covered** |
| 2 | Distinguish 1-business-day high-priority project-risk escalation from 2-hour critical-bug triage; critical-incident exception via Engineering Manager/delegate (no self-approval) | `Chunk 1`, `Chunk 2` (§10/11), `Chunk 3`, `Chunk 4` | **Covered** |
| 3 | Incident-response coordination & owner authority: authorized Engineering incident owner decides containment/production actions; ticket != rollback or deploy approval | `Chunk 3` (§9) | **Missing** |
| 4 | Security/privacy escalation boundary: alert authorized security responder via approved route; never put secrets/customer records/restricted extracts in broad incident comms | `Chunk 3` (§10), `Chunk 4` (§5) | **Missing** |
| 5 | Customer statements require communications authority (no cadence set by D04); formal incident command authority and escalation channel remain unapproved | `Chunk 2` (§10/11), `Chunk 5` (§14) | **Missing** |

### E038 — `What does D07 require at design handoff?` (`5/6 = 83.3%`)
*Change reason vs. WP9.34:* Narrowed point 6 by removing unrelated Finance budget and Jira confirmation clauses while keeping `§4` happy-path prototype gaps and sanitized/synthetic examples (`Chunk 8`).

| # | Essential Point | Supporting Chunk(s) | V0 Status |
| :---: | :--- | :--- | :---: |
| 1 | Permission-safe packaging precise enough to distinguish intended behavior from gaps | `Chunk 1`, `Chunk 4`, `Chunk 8` | **Covered** |
| 2 | Include all 7 required package elements (scope/revision, screens/flows, interactions, copy/labels, layout/assets, accessibility evidence, handoff decisions) | `Chunk 8` (§4 table) | **Covered** |
| 3 | Review, feasibility, and ownership disposition workflow (`§6` Steps 1–5) | `Chunk 4` (§6 Steps 1–5) | **Covered** |
| 4 | Communicate handoff state & prohibit false sign-off claims (`approved for development`, `accessibility passed`, `ready to release`) | `Chunk 1`, `Chunk 4` (§6 Step 6) | **Covered** |
| 5 | Post-handoff change tracking across versions and reviewers (`§6` Step 7) | `Chunk 3`, `Chunk 4` (§6 Step 7), `Chunk 8` | **Covered** |
| 6 | Flag happy-path prototype limitations explicitly and use sanitized/synthetic examples instead of restricted/real customer data | `Chunk 8` (§4) | **Missing** |

### E039 — `What accessibility checks does D07 discuss?` (`6/7 = 85.7%`)
*Change reason vs. WP9.34:* Removed downstream production bug/disagreement escalation (`§7`) as outside the question's focus on accessibility checks; kept all 7 review topics, non-certification framing, and `§5` Recording Practice (`Chunk 2`, `Chunk 8`).

| # | Essential Point | Supporting Chunk(s) | V0 Status |
| :---: | :--- | :--- | :---: |
| 1 | Keyboard operation & visible focus + Labels, semantics, headings/landmarks | `Chunk 2` (§5), `Chunk 8` (§5) | **Covered** |
| 2 | Text, graphics, non-text alternatives, contrast & non-color meaning | `Chunk 2` (§5) | **Covered** |
| 3 | Forms, validation errors, motion, timing & feedback | `Chunk 2` (§5) | **Covered** |
| 4 | Responsive layout & zoom usability | `Chunk 2` (§5) | **Covered** |
| 5 | Assistive technology & testing coverage (tested vs. untested combinations) | `Chunk 2` (§5) | **Covered** |
| 6 | Non-certification framing (no binding WCAG level, contrast/pass gate, or waiver authority) | `Chunk 4`, `Chunk 5`, `Chunk 6`, `Chunk 8` | **Covered** |
| 7 | Recording Practice: version, environment, steps, evidence, follow-up, and `verified`/`requires investigation`/`not evaluated` status; never turn "not tested" into "passes" | `Chunk 2` (§5 Recording practice) | **Missing** |

### E040 — `How should a UI/UX team member use D07 when transferring designs to Engineering?` (`5/6 = 83.3%`)
*Change reason vs. WP9.34:* Removed unrelated Finance budget and Jira confirmation cross-gates (D07 Step 6 already states handoff is not development/accessibility/release approval); retained `§4` happy-path prototype & sanitized/synthetic data safeguards (`Chunk 8`).

| # | Essential Point | Supporting Chunk(s) | V0 Status |
| :---: | :--- | :--- | :---: |
| 1 | Prepare an implementable, permission-safe 7-element package using only material recipients may view | `Chunk 3` (§6 Step 1), `Chunk 8` (§4) | **Covered** |
| 2 | Request cross-functional review (UI/UX, Product, Engineering) and evaluate implementation feasibility/dependencies | `Chunk 3` (§6 Steps 2–3) | **Covered** |
| 3 | Record findings/ownership and disposition unresolved concerns without silent acceptance; escalate risks | `Chunk 3` (§6 Steps 4–5) | **Covered** |
| 4 | Communicate handoff state and refrain from false "approved for development / accessibility passed / ready to release" claims | `Chunk 1`, `Chunk 3` (§6 Step 6) | **Covered** |
| 5 | Handle post-handoff changes traceably with renewed reviewer input | `Chunk 2`, `Chunk 3` (§6 Step 7), `Chunk 8` | **Covered** |
| 6 | Mark happy-path prototype gaps explicitly and use sanitized/synthetic examples rather than real restricted/customer screens | `Chunk 8` (§4) | **Missing** |

