# Evaluation commands and CI

## Local commands

Install Python dependencies with `python -m pip install -r scripts/requirements-eval.txt` in an activated environment. Windows users with the existing virtual environment can run `.\.venv\Scripts\Activate.ps1` first; the Windows Store `python` alias is not a usable interpreter until Python is installed or an environment is activated.

Run `pnpm eval:check` first. It validates the actual golden dataset without credentials
or network requests: exactly 50 cases in the 23/10/7/8/2 allocation, unique integer IDs
and queries, supported categories, corpus bindings, nonempty rubrics and explicit
refusal/citation/length expectations. `pnpm eval:prepare` adapts the same canonical
flat schema into ignored `.promptfoo/golden-tests.json`; `pnpm eval` prepares it and
runs exploratory Promptfoo checks with cache disabled. Promptfoo preserves the full
JSON answer/context/citation envelope for deterministic checks and semantic grading.
Its fixed local HTTP endpoint is for exploration, not streaming latency certification.

| Command | Purpose | Success criteria |
| --- | --- | --- |
| `pnpm eval:py:smoke` | Five streaming staging queries | All transport, format and citation checks pass; if configured, the judge also passes every case |
| `pnpm eval:release` | Full streaming response release gates | Exact golden allocation, two-user isolation, judge, zero request errors, quality and latency thresholds; not full PRD certification |
| `pnpm eval:py:full` | Compatibility alias | Same as `eval:release` |
| `python scripts/eval_runner.py --full --stream` | Explore full-dataset behavior | Deterministic checks and any configured judge; never release certification |

Response release gates require explicit `--release --full --stream` and a single worker.
Citation reference validity must reach 95%, format conformance 99%, and combined
answer passes 95%. Regression cases must independently reach 90%. The judge scores
faithfulness and relevance independently on 0–3; the stored normalized score is the
lower of the two divided by three, with a 2.5/3 pass threshold and aggregate minimum.
Reference keywords are semantic hints; literal keyword matching is not correctness.
The exact no-evidence fallback is accepted only for expected refusal cases. Other
refusals must obey the citation contract and satisfy the judge's refusal rubric;
fulfilling a forbidden request scores zero relevance even if cited. Row-specific
character limits use JavaScript-compatible UTF-16 length.

The p95 time to first token must be at most 2 seconds and p95 total response time at
most 8 seconds, using nearest-rank percentiles on unrounded client observations.
SSE reads use one-byte buffering so requests' default buffer cannot inflate TTFT.
JSON mode has no observed token arrival and records TTFT as zero. Missing streaming
timing samples fail the gate. Transport failures remain recorded even if a retry
succeeds, and retry time is included in latency. Duplicate/missing/out-of-order SSE
events, inconsistent JSON envelopes and invalid metadata fail closed; responses close
on failure as well as success. Deterministically invalid answers skip the model judge.

A smoke run does not require a judge or two-user isolation fixtures. Missing judge results are marked skipped, never semantic passes. Release runs reject missing judges, insufficient datasets and failed isolation before generation begins.

Outputs default to ignored `artifacts/evaluation`; historical tracked results in
`evals/` are marked `historical_unverified` because they lack retrieved citation IDs
and context. Their active pass flags are false and quality aggregates are null.
Original verdicts and scores remain under `legacy_evaluation` and
`legacy_quality_scores` for audit. New runs write to the ignored output directory.
A partial JSONL record is flushed after every case.
Final JSON/CSV artifacts include dataset SHA256, per-category scores, percentile
method, judge scale, error and retry counts. Gate failures exit 1 after writing
results; invalid datasets, arguments or prerequisites exit 2 before model requests.
Per-query JSON preserves the authoritative context and citation payload used for
grading, so verdicts can be audited. These artifacts can contain private corpus
text and stay in the ignored output directory, not the committed golden dataset.

`citation_reference_validity_pct` checks that every inline reference maps to a
nonempty retrieved chunk ID in the response payload. `combined_pass_rate_pct`
requires citation validity, format, transport success and a passing semantic judge.
Claim support is assessed by the judge against the returned evidence.

`gate.passed` and `gate.response_release_gates_passed` describe only the measured
application-response gates. `gate.release_certified` stays false: the PRD also
requires generation cost ≤ ₹0.50 and 100% exact dense-vector recall. Token counts
without audited model pricing do not measure cost, and hybrid search results do not
establish dense-vector recall. `benchmark_coverage` lists these unmeasured gates.
A zero exit status here must not be used as full production-deployment approval.

`pnpm eval:generate --projectId=<UUID>` writes a validated candidate dataset instead
of replacing the golden suite. It reads only authoritative indexed corpus chunks.
`pnpm eval:sync` writes deduplicated, review-required telemetry candidates to
`evals/regression_candidates.json`; negative feedback alone is not reference truth.
Both commands refuse to overwrite existing candidate files. Review source facts and
preserve the 50-case category allocation when promoting changes to golden.

## Pull-request CI

`.github/workflows/ci.yml` runs on pull requests, pushes to `main`, and manual dispatch. It uses Node 24, the pnpm version in `package.json`, Python 3.12, and frozen JavaScript dependencies. It runs:

1. Type checking.
2. ESLint.
3. Application unit/route tests with mocked external services.
4. Python gate, evaluator CLI, dataset validation and mocked HTTP/model tests.
5. Canonical golden validation and Promptfoo case preparation.
6. Database role and Storage webhook contract checks in disposable PostgreSQL.

It does not need Supabase or Gemini secrets. It does not deploy, apply migrations to
hosted Supabase, run live ingestion jobs, or certify the production build. Production
build validation remains a separate check; the existing Windows Turbopack build
limitation is documented in `hardening-validation.md`.

After committing and pushing the workflows, configure a GitHub ruleset/branch protection to require the `Deterministic checks` status before merging. This repository change does not create that remote rule.

## Staging evaluation workflow

Create a GitHub environment named **staging**. Populate it with:

| Type | Name | Value |
| --- | --- | --- |
| Variable | `EVAL_API_URL` | Full deployed staging chat URL, ending in `/api/chat` |
| Variable | `EVAL_PROJECT_ID` | First test user's project containing the golden corpus |
| Variable | `EVAL_OTHER_PROJECT_ID` | A different test user's project, required for release |
| Secret | `EVAL_ACCESS_TOKEN` | Current first-user access token |
| Secret | `EVAL_OTHER_ACCESS_TOKEN` | Current second-user access token, required for release |
| Secret | `EVAL_GEMINI_API_KEY` | Judge API key, required for release and optional for smoke |

Use test-user access tokens, never a Supabase service-role key. Refresh expired tokens before dispatch. Populate the staging corpus with the documents referenced by `evals/golden_dataset.json`; `EVAL_PROJECT_ID` overrides the historical project ID in each row.

In GitHub Actions, choose **Staging evaluation → Run workflow**, select the default branch, and choose `smoke` or `release`. This workflow only runs from the default branch and uses the `staging` environment; it does not run on pull requests. Existing environment protection rules are honored. Runs are serialized to avoid concurrent benchmarking of the same staging service.

Each run uploads only its freshly created `artifacts/evaluation/` directory, including `run.log`, JSON and CSV results, with seven-day retention. Upload runs after failures too. Preflight failures may produce only the log. Shell pipe failure propagation preserves the evaluator's failed status when output is captured. Historical tracked evaluation files are not uploaded as new results.

The workflow records the evaluated commit, but it does not deploy it. Deploy that revision to staging before running release evaluation. A passing release run applies to the configured staging deployment and corpus, not automatically to every deployment of that commit.

References: [GitHub environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments), [artifact uploads](https://github.com/actions/upload-artifact).
