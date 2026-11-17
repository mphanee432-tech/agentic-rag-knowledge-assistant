# Enterprise RAG: 50 golden evaluation cases

**Files:** `enterprise_golden_50.json` and `run_enterprise_decisions_eval.py`.

These files are **new, separate Enterprise RAG evaluation fixtures**. Your repository's existing `evals/golden_dataset.json` and `scripts/eval_runner.py` target a different Personal RAG corpus; do not overwrite them.

The 50 **candidate** cases cover: 32 company-wide Standard policy facts (D01, D02, D08, D10); 8 department-specific Standard cases (D04, D07); 6 unauthorized document access tests; 2 unsupported policy/refusal tests; and 2 prompt-injection refusals. Questions were designed around documents observed in the Enterprise **test** database. Criteria for D04/D07 are evidence-first rather than fixed fact strings; a reviewer must approve them as true goldens. Denial tests are only valid when the selected persona truly lacks the relevant grants.

## Setup (Windows PowerShell) — configure once

1. Copy `run_enterprise_decisions_eval.py`, `enterprise_golden_50.json` and this README to the root of `rag-knowledge-assistant`. The runner expects `.env.test.local` alongside itself.
2. Install the one small dependency if needed: `python -m pip install python-dotenv` (one time). `--validate` does not require it.
3. Reuse your existing **Enterprise test** `.env.test.local`. Add the following entries once, keeping your existing test Supabase URL and publishable/anon key. Replace the placeholder values with your existing **test account** credentials:

```dotenv
# Keep existing NEXT_PUBLIC_SUPABASE_URL for cpowlkptvtnkjkulveph,
# and NEXT_PUBLIC_SUPABASE_ANON_KEY (or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY).
EVAL_EMAIL_ENGINEERING=YOUR_ENGINEERING_TEST_ACCOUNT_EMAIL
EVAL_PASSWORD_ENGINEERING=YOUR_ENGINEERING_TEST_ACCOUNT_PASSWORD
EVAL_EMAIL_UIUX=YOUR_UIUX_TEST_ACCOUNT_EMAIL
EVAL_PASSWORD_UIUX=YOUR_UIUX_TEST_ACCOUNT_PASSWORD
EVAL_GEMINI_API_KEY=YOUR_GOOGLE_AI_STUDIO_API_KEY
```

Alternative: use `EVAL_TOKEN_ENGINEERING` / `EVAL_TOKEN_UIUX` instead of email and password (these short-lived tokens must be refreshed). `EVAL_GEMINI_API_KEY` may instead be `GEMINI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` **in `.env.test.local`**. Do **not** use service-role/secret keys for user login.

The script loads `.env.test.local` **automatically on every run**, so you do **not** need to set `$env:...` again in PowerShell. Test-file settings take precedence over inherited environment variables. As a safety check, it refuses to run unless `NEXT_PUBLIC_SUPABASE_URL` points to **`https://cpowlkptvtnkjkulveph.supabase.co`**. It never falls back to the Personal RAG project.

Your repository's existing `.gitignore` already excludes `.env.test.local`; never force-add it. The script does not write passwords or tokens to results.

Start `pnpm run dev:test` in one terminal, then run the commands below from a **second** terminal in the same project root.

## Commands

```powershell
python .\run_enterprise_decisions_eval.py --validate
python .\run_enterprise_decisions_eval.py --limit 3 --persona engineering
python .\run_enterprise_decisions_eval.py
```

The script sends authenticated read-only JSON-mode queries to `http://127.0.0.1:3000/api/chat`. The chat API returns answer, evidence and citation metadata. Each result is graded with **Gemini Decisions API**, model `gemini-decision-1`, using a `noul` yes/no probability for correctness and grounding. The Python script also checks citations/refusal format deterministically. A case passes only if both model probabilities are at least 0.80 and deterministic checks pass. Cases from 0.60 to 0.80 are REVIEW. Missing key, malformed API response, or model quota errors are ERROR, not successful evaluations.

Results are written to `enterprise_eval_results.json` (metadata, probabilities and verdicts only; **not** the full document content or answers). Don't commit eval credentials. Running the suite sends retrieved document text to Google's judge API, consistent with your already Gemini-backed architecture; use only your synthetic test corpus. Never run this against real sensitive employee records without approval.

**Important limitations:** No live API requests were executed while preparing these files: the code and 50-case structure were validated locally, but live authentication, app response parsing, Decisions API response structure and full end-to-end grading must be verified on your computer. Decisions judge probabilities are not evidence of zero security leaks. Run separate RLS/database access tests, and manually audit cases marked REVIEW/FAIL. This runner intentionally does **not** call Jira creation/status endpoints or create tickets.

Sources: [Google's Gemini Decisions API announcement](https://blog.google/innovation-and-ai/technology/developers-tools/gemini-decisions-api/), [Google Decisions codelab](https://codelabs.developers.google.com/codelabs/discriminative-models).
