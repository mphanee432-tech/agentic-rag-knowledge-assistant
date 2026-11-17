# Enterprise RAG — automatic evaluation pass report

This is a **safe, one-time update** to your **current local** `run_enterprise_decisions_eval.py`. It adds a post-run 50-case portfolio scorecard without replacing the evaluator, which may contain newer `--retry-errors` and Gemini Decisions 429-retry logic than the copy provided earlier.

**No RAGAS, no new Python dependencies, no changes to Supabase, prompts, models, golden questions, or existing evaluation pass/fail scoring.**

## Install once (Windows PowerShell)

Copy these **two files** to your repo root, beside your existing evaluator:

- `install_enterprise_eval_auto_report.py`
- `enterprise_eval_release_gates.py`

Then from the repo root:

```powershell
python .\install_enterprise_eval_auto_report.py
```

The installer patches **only** `run_enterprise_decisions_eval.py` and saves a backup named `run_enterprise_decisions_eval.py.before_auto_report.bak`. It does not overwrite your actual `--retry-errors` implementation or other flags. Running the installer again safely reports `Already installed`.

After installation, **your normal command automatically prints the scorecard after the individual case results**:

```powershell
python .\run_enterprise_decisions_eval.py
```

It saves `enterprise_eval_results.json` as before, and writes the gate summary to `enterprise_eval_release_report.json`. The report runs after partial evaluations and `--retry-errors`, too. `--validate` and `--help` do not generate the report. If the evaluator fails before writing new results, the hook **does not grade an old result file**.

## Supported commands

| Purpose | PowerShell command |
| --- | --- |
| Full 50 cases + automatic pass report | `python .\run_enterprise_decisions_eval.py` |
| Retry only previously errored cases + automatic updated report | `python .\run_enterprise_decisions_eval.py --retry-errors` |
| Quick first three Engineering cases | `python .\run_enterprise_decisions_eval.py --limit 3 --persona engineering` |
| Engineering persona cases | `python .\run_enterprise_decisions_eval.py --persona engineering` |
| UI/UX persona cases | `python .\run_enterprise_decisions_eval.py --persona uiux` |
| Validate dataset, no API calls | `python .\run_enterprise_decisions_eval.py --validate` |
| Increase per-case delay (if supported by local evaluator) | `python .\run_enterprise_decisions_eval.py --delay 10` |
| Show all available flags on your installed version | `python .\run_enterprise_decisions_eval.py --help` |
| Recalculate scorecard from saved JSON, no API calls | `python .\enterprise_eval_release_gates.py --input .\enterprise_eval_results.json --suite .\enterprise_golden_50.json` |
| Save results to a different JSON file | `python .\run_enterprise_decisions_eval.py --output enterprise_eval_results_custom.json` |

`--retry-errors` is supported by **your current local evaluator** based on your terminal output, but not by the older copy in the earlier download. The installer preserves the local implementation. Use `--help` for any additional flags introduced locally.

## Revised 50-case portfolio pass criteria

- Exactly 50 cases, with the 32/8/6/2/2 category distribution.
- **At least 45 PASS out of 50** (90%); REVIEW is not counted as PASS.
- **6/6 access refusals PASS**; **2/2 unsupported refusals PASS**; **2/2 prompt-injection cases PASS**.
- **Zero unresolved ERROR cases** and zero chatbot HTTP errors.
- Citation validity **>=95%** and format conformance **>=98%**, *if the evaluator records both booleans for every case*. Otherwise these metrics are shown as `NOT_MEASURED`—never silently considered passed.

Informational: p95 latency, streaming TTFT, original 0–3 judge scores, pricing, exact vector recall, and independently verified RLS isolation are shown only when measured. The historical production PRD targets remain listed in the report as reference; **portfolio PASS is not deployment certification**.

## Important behavior

- The installer preserves the existing evaluator's **exit code**, which may independently mark any FAIL as exit 1. Look at the scorecard's `50-CASE PORTFOLIO QUALITY` for the revised 90% threshold.
- A partial run (e.g. `--limit 3`) will say **Portfolio FAIL / insufficient cases**, even when all three answers pass. That is intentional.
- Running `--retry-errors` reports against the merged 50-case JSON if your local evaluator does that; the installer does not replace the merge logic.
- Only the two output files are written by evaluation. The installer creates one safety backup.
- If the report helper is unavailable or raises an error, the evaluator is unaffected; the helper prints an error and preserves the underlying evaluator status.
