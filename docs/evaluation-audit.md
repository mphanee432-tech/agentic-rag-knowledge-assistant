# Golden evaluation audit — 2026-11-04

The suite remains 50 cases: 23 fact lookups, 10 edge cases, 7 multi-hop, 8
adversarial/refusals and 2 regressions. It tests the uploaded LearnRAG blueprint;
its described Qdrant/embedding stack is reference-document content, not the current
application implementation. Changing those facts to match the app would corrupt
the evaluation target.

| Finding | Repair |
| --- | --- |
| Flat golden schema incompatible with Promptfoo and maintenance scripts | Canonical schema validation in both runtimes; generated Promptfoo adapter |
| Row expectations ignored by Python | Enforced refusal/length behavior; rubric and semantic hints sent to judge |
| Binary judge did not implement PRD 2.5/3 scoring | Independently graded faithfulness/relevance; lower score gates correctness |
| Fixed chunk positions and placeholder citation in rubrics | Retrieval-order-independent source requirements |
| Monthly cost answer assumed unspecified turns/session | Conditional arithmetic rubric; no unsupported “under $3” answer |
| Broken range characters | Repaired range text without changing reference facts |
| Response transform discarded context and citations | Full JSON envelope retained for deterministic and semantic checks |
| Generator/telemetry could replace or contaminate golden | Separate reviewed candidates; no overwrite or silent schema mixing |
| Buffered SSE distorted TTFT; percentile method varied | One-byte SSE reads; client timestamps; nearest-rank p95 |
| Retry/partial failures and malformed responses could look valid | Strict stream/envelope checks, closed responses, persistent errors and partial artifacts |
| Regression bucket failures hidden in aggregate pass rate | Independent 90% regression gate |
| Response checks mislabeled full release certification | Explicit response-gate verdict; full certification false without cost/recall evidence |

PRD targets used: citation validity ≥95%, format ≥99%, faithfulness/relevance
≥2.5/3, regression ≥90%, zero observed tenant-isolation violations, p95 TTFT ≤2s,
p95 total ≤8s. The existing combined-answer threshold ≥95% is retained.

Generation cost ≤₹0.50 and exact dense-vector recall =100% are explicitly unmeasured.
They require audited model pricing/usage and an independent exact-search comparison,
respectively. Neither retrieved citation IDs nor a positive judge score proves them.

Validation was offline: canonical dataset checks, malformed-response/scoring tests,
and Promptfoo execution of all 50 file assertions with a mocked provider and no
semantic judge. A mocked replay is wiring validation, not a quality or latency score.
Historical evaluation artifacts were preserved; no live models or Supabase writes
were used for this audit. Corpus reference facts still require human review when
promoting generated or telemetry-derived cases.
