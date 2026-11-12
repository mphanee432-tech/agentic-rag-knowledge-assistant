"""Align the active ngrok tunnel and Vault; inspect without printing secrets.

Requires a Supabase management access token, not the application service-role key.
--apply applies missing repository migrations, updates Vault and activates Cron.
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]


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


def tunnel_url():
    response = requests.get("http://127.0.0.1:4040/api/tunnels", timeout=10)
    response.raise_for_status()
    urls = {t["public_url"] for t in response.json()["tunnels"]
            if t["public_url"].startswith("https://") and
            t.get("config", {}).get("addr") in ("http://localhost:3000", "http://127.0.0.1:3000", "localhost:3000", "3000")}
    if len(urls) != 1:
        raise RuntimeError("Expected one HTTPS ngrok tunnel forwarding to port 3000.")
    return urls.pop() + "/api/webhooks/storage"


def synchronize(ref, token, url, secret):
    # Reject partial hardening rather than guessing how to repair an existing schema.
    state = query(ref, token, """select
      exists(select 1 from pg_policies where schemaname='public' and tablename='projects' and policyname='owner_boundary') as hardened,
      exists(select 1 from information_schema.columns where table_schema='public' and table_name='documents' and column_name='expected_size') as reserved,
      to_regprocedure('public.recover_document_ingestion()') is not null as recovery;""")[0]
    if state["hardened"] != state["reserved"]:
        raise RuntimeError("Partial hardening found. Review the database before applying migrations.")
    query(ref, token, "create extension if not exists pg_net; create extension if not exists pg_cron; create extension if not exists supabase_vault;")
    if not state["hardened"]:
        query(ref, token, (ROOT / "supabase/migrations/202610280001_harden_access_and_ingestion.sql").read_text())
        print("Applied access/ingestion hardening migration.")
    if not state["recovery"]:
        query(ref, token, (ROOT / "supabase/migrations/202611040001_automatic_ingestion_recovery.sql").read_text())
        print("Applied automatic recovery migration.")
    sql = ["begin; select pg_advisory_xact_lock(hashtext('sync-ingestion-vault'));"]
    for name, value in (("ingestion_webhook_url", url), ("ingestion_webhook_secret", secret)):
        sql.append(f"select vault.update_secret(id, {literal(value)}) from vault.decrypted_secrets where name={literal(name)};")
        sql.append(f"select vault.create_secret({literal(value)}, {literal(name)}) where not exists (select 1 from vault.decrypted_secrets where name={literal(name)});")
    sql.append("select cron.schedule('recover-document-ingestion', '* * * * *', 'select public.recover_document_ingestion();');")
    sql.append("select cron.alter_job((select jobid from cron.job where jobname='recover-document-ingestion'), active := true); commit;")
    query(ref, token, "\n".join(sql))
    query(ref, token, (ROOT / "supabase/migrations/202611040002_align_storage_webhook.sql").read_text())
    query(ref, token, (ROOT / "supabase/migrations/20261104094738_restrict_cleanup_trigger_execution.sql").read_text())
    print("Aligned Vault, Storage INSERT trigger and active recovery Cron job.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    load_dotenv(ROOT / ".env.local")
    load_dotenv(ROOT / ".env")
    try:
        url = tunnel_url()
        print("Active webhook URL:", url)
        token, secret = os.getenv("SUPABASE_ACCESS_TOKEN"), os.getenv("SUPABASE_WEBHOOK_SECRET")
        host = urlsplit(os.getenv("NEXT_PUBLIC_SUPABASE_URL", "")).hostname or ""
        if not re.fullmatch(r"[a-z0-9]+\.supabase\.co", host) or not token or not secret:
            raise RuntimeError("Configure SUPABASE_ACCESS_TOKEN and SUPABASE_WEBHOOK_SECRET for the app's hosted Supabase project.")
        ref = host.split(".")[0]
        if args.apply:
            synchronize(ref, token, url, secret)
        rows = query(ref, token, f"""select
          (select count(*)=1 and bool_and(decrypted_secret={literal(url)}) from vault.decrypted_secrets where name='ingestion_webhook_url') as vault_url_matches,
          (select count(*)=1 and bool_and(decrypted_secret={literal(secret)}) from vault.decrypted_secrets where name='ingestion_webhook_secret') as vault_secret_matches,
          exists(select 1 from cron.job where jobname='recover-document-ingestion' and active and schedule='* * * * *' and command='select public.recover_document_ingestion();') as cron_active,
          exists(select 1 from pg_trigger where tgrelid='storage.objects'::regclass and tgname='storage.objects.insert' and tgenabled in ('O','A') and (tgtype & 4)=4 and tgfoid=to_regprocedure('public.dispatch_document_ingestion()')) as storage_trigger_aligned,
          exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='documents') as realtime_enabled;""")
        print(json.dumps(rows, indent=2))
        return 0 if rows and all(value is True for value in rows[0].values()) else 1
    except RuntimeError as error:
        print("FAIL:", error)
    except (requests.RequestException, ValueError, KeyError):
        print("FAIL: Connection or response error; details omitted to protect secrets.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
