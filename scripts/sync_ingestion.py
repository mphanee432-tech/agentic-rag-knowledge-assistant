"""Inspect Agentic ingestion bindings; --apply activates one explicitly selected workspace.

Never targets generic/Classic RAG URLs or replays application migrations.
Live --apply requires approval: Cron may dispatch existing eligible documents.
"""
import argparse
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
AGENTIC_PROJECTS = {
    "personal": ("jdwttbkjpssrbeaoyzkc", "agentic-personal-rag"),
    "enterprise": ("ldkxyleqfbovqpkpoyek", "agentic-enterprise-rag"),
}


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def query(ref, token, sql):
    response = requests.post(f"https://api.supabase.com/v1/projects/{ref}/database/query",
                             headers={"Authorization": f"Bearer {token}"}, json={"query": sql},
                             timeout=90, allow_redirects=False)
    if not response.ok:
        # Query errors can echo SQL containing a secret.
        raise RuntimeError(f"Management SQL failed: HTTP {response.status_code}; response omitted.")
    return response.json()


def project_ref(workspace):
    ref, _ = AGENTIC_PROJECTS[workspace]
    configured = os.getenv(f"NEXT_PUBLIC_{workspace.upper()}_SUPABASE_URL", "").rstrip("/")
    if configured != f"https://{ref}.supabase.co":
        raise RuntimeError("Scoped URL must match the selected Agentic project. Generic URLs are never used.")
    return ref


def verify_project(workspace, ref, token):
    expected_ref, expected_name = AGENTIC_PROJECTS[workspace]
    if ref != expected_ref:
        raise RuntimeError("Refusing to access a project other than the selected Agentic clone.")
    response = requests.get(f"https://api.supabase.com/v1/projects/{ref}",
                            headers={"Authorization": f"Bearer {token}"},
                            timeout=30, allow_redirects=False)
    if not response.ok:
        raise RuntimeError(f"Project identity check failed: HTTP {response.status_code}; response omitted.")
    project = response.json()
    if ref != expected_ref or project.get("id") != ref or project.get("name") != expected_name:
        raise RuntimeError("Refusing to configure a project other than the selected Agentic clone.")


def tunnel_url():
    response = requests.get("http://127.0.0.1:4040/api/tunnels", timeout=10, allow_redirects=False)
    response.raise_for_status()
    urls = {t["public_url"] for t in response.json()["tunnels"]
            if t["public_url"].startswith("https://") and
            t.get("config", {}).get("addr") in ("http://localhost:3000", "http://127.0.0.1:3000", "localhost:3000", "3000")}
    if len(urls) != 1:
        raise RuntimeError("Expected one HTTPS ngrok tunnel forwarding to port 3000.")
    return urls.pop()


def webhook_url(base, workspace):
    parsed = urlsplit(base)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path not in ("", "/")
            or parsed.hostname in ("localhost", "127.0.0.1", "::1")):
        raise RuntimeError("Use a public HTTPS origin without credentials, query, fragment or path.")
    return base.rstrip("/") + f"/api/webhooks/storage?workspace={workspace}"


def preflight(ref, token):
    return query(ref, token, """select
      (select count(*)=3 from pg_extension where extname in ('pg_net','pg_cron','supabase_vault')) as extensions_ready,
      to_regprocedure('public.claim_document_ingestion(uuid,uuid)') is not null as claim_ready,
      to_regprocedure('public.fail_document_ingestion(uuid,uuid,text,boolean)') is not null as failure_ready,
      to_regprocedure('public.finish_document_ingestion(uuid,uuid,jsonb)') is not null as finish_ready,
      to_regprocedure('public.recover_document_ingestion()') is not null as recovery_ready,
      (select count(*)=4 from information_schema.columns where table_schema='public' and table_name='documents'
        and column_name in ('ingestion_attempts','next_ingestion_attempt_at','ingestion_dispatched_at','last_ingestion_error')) as retry_columns_ready,
      exists(select 1 from storage.buckets where id='documents' and not public) as private_bucket_ready,
      to_regprocedure('public.can_upload_enterprise_policy(uuid)') is not null
        and to_regprocedure('public.reserve_enterprise_policy(uuid,uuid,uuid,text,bigint,text,text)') is not null
        and to_regprocedure('public.publish_enterprise_document(uuid)') is not null
        and to_regprocedure('public.enterprise_policy_departments(uuid)') is not null
        and to_regprocedure('public.enterprise_copilot_context(uuid)') is not null as enterprise_upload_ready;""")[0]


def check_prerequisites(state, workspace):
    required = ("extensions_ready", "claim_ready", "failure_ready", "finish_ready",
                "recovery_ready", "retry_columns_ready", "private_bucket_ready")
    if not all(state.get(key) is True for key in required):
        raise RuntimeError("Ingestion prerequisites are missing; review the schema separately. No migrations will be replayed.")
    if workspace == "enterprise" and not state["enterprise_upload_ready"]:
        raise RuntimeError("Enterprise upload/publication authorization RPCs are missing. Restore the approved contracts separately; no authorization schema will be changed.")


def synchronize(workspace, ref, token, url, secret):
    parsed = urlsplit(url)
    if url != webhook_url(f"{parsed.scheme}://{parsed.netloc}", workspace):
        raise RuntimeError("Webhook URL does not match the selected workspace.")
    verify_project(workspace, ref, token)
    check_prerequisites(preflight(ref, token), workspace)
    sql = ["begin; set local lock_timeout = '5s'; select pg_advisory_xact_lock(hashtext('sync-ingestion-vault'));"]
    for name, value in (("ingestion_webhook_url", url), ("ingestion_webhook_secret", secret)):
        sql.append(f"select vault.update_secret(id, {literal(value)}) from vault.decrypted_secrets where name={literal(name)};")
        sql.append(f"select vault.create_secret({literal(value)}, {literal(name)}) where not exists (select 1 from vault.decrypted_secrets where name={literal(name)});")
    sql.append((ROOT / "supabase/ingestion/automatic_dispatch.sql").read_text())
    sql.append("commit;")
    query(ref, token, "\n".join(sql))
    print(f"Activated {workspace} Storage dispatch and recovery Cron; eligible documents may now be processed.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", choices=AGENTIC_PROJECTS, required=True)
    parser.add_argument("--webhook-base-url", help="Public HTTPS origin; defaults to the local ngrok tunnel")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    load_dotenv(ROOT / ".env.local")
    load_dotenv(ROOT / ".env")
    try:
        ref = project_ref(args.workspace)
        token = os.getenv("SUPABASE_ACCESS_TOKEN")
        secret = os.getenv(f"{args.workspace.upper()}_SUPABASE_WEBHOOK_SECRET") or os.getenv("SUPABASE_WEBHOOK_SECRET")
        if not token or not secret:
            raise RuntimeError("Configure SUPABASE_ACCESS_TOKEN and the workspace webhook secret (or shared SUPABASE_WEBHOOK_SECRET) securely.")
        url = webhook_url(args.webhook_base_url or tunnel_url(), args.workspace)
        if args.apply:
            synchronize(args.workspace, ref, token, url, secret)
        else:
            verify_project(args.workspace, ref, token)
        state = preflight(ref, token)
        print(json.dumps({"workspace": args.workspace, "project_ref": ref, "prerequisites": state}, indent=2))
        if not state["extensions_ready"]:
            check_prerequisites(state, args.workspace)
        rows = query(ref, token, f"""select
          (select count(*)=1 and bool_and(decrypted_secret={literal(url)}) from vault.decrypted_secrets where name='ingestion_webhook_url') as vault_url_matches,
          (select count(*)=1 and bool_and(decrypted_secret={literal(secret)}) from vault.decrypted_secrets where name='ingestion_webhook_secret') as vault_secret_matches,
          exists(select 1 from cron.job where jobname='recover-document-ingestion' and active and schedule='* * * * *' and command='select public.recover_document_ingestion();') as cron_active,
          exists(select 1 from pg_trigger where tgrelid='storage.objects'::regclass and tgname='storage.objects.insert' and tgenabled in ('O','A') and (tgtype & 4)=4 and tgfoid=to_regprocedure('public.dispatch_document_ingestion()')) as storage_trigger_aligned,
          exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='documents') as realtime_enabled;""")
        print(json.dumps(rows, indent=2))
        check_prerequisites(state, args.workspace)
        return 0 if rows and all(value is True for value in rows[0].values()) else 1
    except RuntimeError as error:
        print("FAIL:", error)
    except (requests.RequestException, ValueError, KeyError):
        print("FAIL: Connection or response error; details omitted to protect secrets.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
