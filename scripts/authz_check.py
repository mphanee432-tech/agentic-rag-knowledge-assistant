"""Exercise a dedicated staging app and Supabase with two disposable identities.

Only AUTHZ_* settings are used. Service credentials provision/inspect/clean fixtures;
all authorization probes use real user sessions or the anonymous key.
"""
import os
import secrets
import sys
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import requests
from dotenv import load_dotenv


class CheckFailed(Exception):
    pass


def require(condition, label):
    if not condition:
        raise CheckFailed(label)


def configuration():
    load_dotenv(Path(__file__).resolve().parents[1] / ".env.authz.local")
    names = ("AUTHZ_APP_URL", "AUTHZ_SUPABASE_URL", "AUTHZ_SUPABASE_ANON_KEY",
             "AUTHZ_SUPABASE_SERVICE_ROLE_KEY")
    values = [os.getenv(name, "").strip() for name in names]
    require(all(values), "Configure all four AUTHZ_* settings in .env.authz.local or the environment.")
    for value in values[:2]:
        url = urlsplit(value)
        require(url.scheme == "https" and url.hostname and not url.username and not url.password
                and url.path in ("", "/") and not url.query and not url.fragment,
                "AUTHZ URLs must be HTTPS origins for the dedicated staging deployment.")
    require(values[2] != values[3], "Anonymous and service keys must be different.")
    return values[0].rstrip("/"), values[1].rstrip("/"), values[2], values[3]


class BoundaryChecks:
    def __init__(self, app, supabase, anon, service):
        self.app, self.supabase, self.anon, self.service = app, supabase, anon, service
        self.users, self.paths = [], []
        self.passed = 0

    def request(self, method, path, token=None, *, app=False, **kwargs):
        headers = dict(kwargs.pop("headers", {}))
        if not app:
            headers["apikey"] = self.service if token == self.service else self.anon
        if token:
            headers["Authorization"] = f"Bearer {token}"
        try:
            # Never forward credentials to a redirect or print URLs containing signed tokens.
            return requests.request(method, (self.app if app else self.supabase) + path,
                                    headers=headers, timeout=30, allow_redirects=False, **kwargs)
        except requests.RequestException:
            raise CheckFailed("Network request failed; endpoint and credentials omitted.") from None

    def expect(self, response, status, label):
        require(response.status_code == status, f"{label}: expected HTTP {status}, got {response.status_code}.")
        self.passed += 1
        return response

    def denied(self, response, label):
        require(response.status_code in (401, 403) and response.json().get("code") == "42501",
                f"{label}: expected PostgreSQL permission denial (42501), got HTTP {response.status_code}.")
        self.passed += 1

    def rows(self, table, token, **filters):
        response = self.request("GET", f"/rest/v1/{table}", token,
                                params={"select": "*", **{k: f"eq.{v}" for k, v in filters.items()}})
        return self.expect(response, 200, f"Read {table}").json()

    def seed(self, table, row):
        self.expect(self.request("POST", f"/rest/v1/{table}", self.service, json=row), 201, f"Seed {table}")

    def setup(self):
        for _ in range(2):
            email = f"authz-{uuid4().hex}@example.com"
            password = secrets.token_urlsafe(32)
            response = self.expect(self.request("POST", "/auth/v1/admin/users", self.service,
                                   json={"email": email, "password": password, "email_confirm": True}),
                                   200, "Create disposable user")
            user = {"id": str(UUID(response.json()["id"]))}
            self.users.append(user)
            session = self.expect(self.request("POST", "/auth/v1/token", params={"grant_type": "password"},
                                  json={"email": email, "password": password}), 200, "Password sign-in").json()
            require(session["user"]["id"] == user["id"], "Session identity mismatch")
            user["token"] = session["access_token"]
        require(self.users[0]["id"] != self.users[1]["id"], "Fixtures must have distinct identities")
        for user, other in (self.users, self.users[::-1]):
            token = user["token"]
            project = self.expect(self.request("POST", "/api/projects", token, app=True,
                                  json={"name": "Authorization fixture", "user_id": other["id"]}),
                                  201, "Create own project despite forged owner").json()["project"]
            project_id = str(UUID(project["id"]))
            owned = self.rows("projects", self.service, id=project_id, user_id=user["id"])
            require(len(owned) == 1, "App must use the verified session owner")
            user["project"] = project_id
            reservation = self.expect(self.request("POST", "/api/documents/upload-url", token, app=True,
                                      json={"projectId": project_id, "filename": "authz.txt", "fileSize": 5}),
                                      200, "Reserve own upload").json()
            doc_id = str(UUID(reservation["documentId"]))
            path = f"{user['id']}/{project_id}/{doc_id}/authz.txt"
            require(reservation["storagePath"] == path, "Upload path must bind user, project and document")
            self.paths.append(path)
            require(len(self.rows("documents", self.service, id=doc_id, project_id=project_id)) == 1,
                    "Reservation must belong to fixture project")
            user.update(document=doc_id, path=path, upload_token=reservation["token"])
            # Avoid triggering paid ingestion when the real Storage INSERT webhook fires.
            self.expect(self.request("PATCH", "/rest/v1/documents", self.service, params={"id": f"eq.{doc_id}"},
                                    json={"status": "indexed", "next_ingestion_attempt_at": None}), 204, "Prepare upload fixture")
            self.expect(self.request("PUT", f"/storage/v1/object/upload/sign/documents/{path}", token,
                                    params={"token": reservation["token"]}, data=b"hello",
                                    headers={"Content-Type": "text/plain", "x-upsert": "false"}), 200, "Signed upload works")
            user["chunk"], user["interaction"] = str(uuid4()), str(uuid4())
            self.seed("document_chunks", {"id": user["chunk"], "document_id": doc_id, "project_id": project_id,
                                         "content": "Authorization fixture", "metadata": {}, "embedding": [1.0] + [0.0] * 1535})
            self.seed("interactions", {"id": user["interaction"], "project_id": project_id, "query_text": "Fixture",
                                       "response_markdown": "Fixture answer", "retrieved_chunk_ids": [user["chunk"]], "latency_ms": 0})

    def app_checks(self, own, other):
        token = own["token"]
        self.expect(self.request("POST", "/api/webhooks/storage", token, app=True,
                                 json={"storagePath": own["path"]}), 401, "User session cannot invoke worker webhook")
        for who, status in ((own, 200), (other, 404)):
            for path, params in (("/api/projects", {"id": who["project"]}),
                                 ("/api/documents", {"projectId": who["project"]})):
                response = self.expect(self.request("GET", path, token, app=True, params=params), status, "App read ownership")
                if status == 200:
                    body = response.json()
                    require(body["project"]["id"] == own["project"] if path == "/api/projects" else
                            {d["id"] for d in body["documents"]} == {own["document"]}, "Owner read returned wrong fixture")
        projects = self.expect(self.request("GET", "/api/projects", token, app=True), 200, "List own projects").json()["projects"]
        require({p["id"] for p in projects} == {own["project"]}, "Project list must contain only own fixture")
        for method, path, body, params in (
            ("POST", "/api/documents/upload-url", {"projectId": other["project"], "filename": "attack.txt", "fileSize": 5}, None),
            ("DELETE", "/api/documents", None, {"documentId": other["document"]}),
            ("POST", "/api/feedback", {"interactionId": other["interaction"], "rating": "thumbs_down"}, None),
            ("POST", "/api/chat", {"projectId": other["project"], "query": "Authorization probe", "stream": True}, None),
        ):
            self.expect(self.request(method, path, token, app=True, json=body, params=params), 404, "App denies foreign operation")
        self.expect(self.request("POST", "/api/feedback", token, app=True,
                                 json={"interactionId": own["interaction"], "rating": "thumbs_up"}), 200, "Own feedback works")
        require(self.rows("interactions", self.service, id=own["interaction"])[0]["feedback"]["rating"] == "thumbs_up",
                "App feedback must persist")

    def database_checks(self, own, other):
        token = own["token"]
        for table, key in (("projects", "project"), ("documents", "document"),
                           ("document_chunks", "chunk"), ("interactions", "interaction")):
            require(len(self.rows(table, token, id=own[key])) == 1, f"Owner can read {table}")
            require(self.rows(table, token, id=other[key]) == [], f"RLS hides foreign {table}")
            self.denied(self.request("GET", f"/rest/v1/{table}", params={"id": f"eq.{other[key]}"}), "Anonymous table access")
        for method, table, body in (("PATCH", "projects", {"name": "Stolen"}), ("DELETE", "projects", None),
                                    ("DELETE", "documents", None), ("PATCH", "interactions", {"feedback": {"rating": "thumbs_down"}})):
            key = {"projects": "project", "documents": "document", "interactions": "interaction"}[table]
            response = self.expect(self.request(method, f"/rest/v1/{table}", token,
                                   params={"id": f"eq.{other[key]}"}, json=body,
                                   headers={"Prefer": "return=representation"}), 200, "RLS foreign mutation")
            require(response.json() == [], "Foreign mutation must affect zero rows")
        self.denied(self.request("PATCH", "/rest/v1/projects", token, params={"id": f"eq.{own['project']}"},
                                json={"user_id": other["id"]}), "Cannot transfer ownership")
        self.denied(self.request("POST", "/rest/v1/projects", token,
                                json={"user_id": other["id"], "name": "Forged"}), "Cannot create foreign project")
        for table, key in (("documents", "document"), ("document_chunks", "chunk"), ("interactions", "interaction")):
            row = self.rows(table, self.service, id=own[key])[0]
            row["id"] = str(uuid4())
            self.denied(self.request("POST", f"/rest/v1/{table}", token, json=row), f"Cannot forge {table}")
        self.denied(self.request("PATCH", "/rest/v1/interactions", token, params={"id": f"eq.{own['interaction']}"},
                                json={"response_markdown": "Forged answer"}), "Telemetry columns immutable to user")
        for rating in ("thumbs_down", "thumbs_up"):
            self.expect(self.request("PATCH", "/rest/v1/interactions", token, params={"id": f"eq.{own['interaction']}"},
                                     json={"feedback": {"rating": rating}}), 204, "Feedback column allowed")
            require(self.rows("interactions", self.service, id=own["interaction"])[0]["feedback"]["rating"] == rating,
                    "Direct feedback update must persist")
        self.expect(self.request("PATCH", "/rest/v1/projects", token, params={"id": f"eq.{own['project']}"},
                                 json={"name": "Own rename"}), 204, "Owner rename allowed")
        require(self.rows("projects", self.service, id=own["project"])[0]["name"] == "Own rename", "Owner rename must persist")

    def storage_checks(self, own, other):
        path = f"/storage/v1/object/authenticated/documents/{other['path']}"
        for token in (None, own["token"]):
            response = self.request("GET", path, token)
            require(response.status_code in (400, 401, 403, 404), "Storage must deny foreign/anonymous reads")
            self.passed += 1
        response = self.request("GET", f"/storage/v1/object/public/documents/{other['path']}")
        require(response.status_code in (400, 401, 403, 404), "Bucket must not expose public objects")
        for token in (own["token"], other["token"]):
            response = self.request("DELETE", "/storage/v1/object/documents", token, json={"prefixes": [other["path"]]})
            require(response.status_code in (200, 400, 401, 403), "Storage delete request must reach the service")
            content = self.expect(self.request("GET", path, other["token"]), 200, "Denied direct delete preserves object")
            require(content.content == b"hello", "Stored bytes must remain intact")
        fresh = f"{other['id']}/{other['project']}/{uuid4()}/forged.txt"
        own_fresh = f"{own['id']}/{own['project']}/{uuid4()}/direct.txt"
        self.paths.extend([fresh, own_fresh])
        for method, path, params in (
            ("POST", f"/storage/v1/object/documents/{own_fresh}", None),
            ("POST", f"/storage/v1/object/documents/{fresh}", None),
            ("PUT", f"/storage/v1/object/upload/sign/documents/{fresh}", {"token": own["upload_token"]}),
            ("PUT", f"/storage/v1/object/documents/{own['path']}", None),
            ("PUT", f"/storage/v1/object/documents/{other['path']}", None),
        ):
            response = self.request(method, path, own["token"], params=params, data=b"stolen",
                                    headers={"Content-Type": "text/plain"})
            require(response.status_code in (400, 401, 403), "Storage must reject unauthorized writes")
            self.passed += 1
        content = self.expect(self.request("GET", f"/storage/v1/object/authenticated/documents/{other['path']}",
                                           other["token"]), 200, "Owner Storage read works")
        require(content.content == b"hello", "Unauthorized write changed object")
        own_content = self.expect(self.request("GET", f"/storage/v1/object/authenticated/documents/{own['path']}",
                                               own["token"]), 200, "Direct overwrite preserves own object")
        require(own_content.content == b"hello", "Direct overwrite changed own object")

    def rpc_checks(self, own, other):
        lease = str(uuid4())
        for name, body in (
            ("match_chunks_hybrid_rrf", {"query_embedding": [1.0] + [0.0] * 1535, "query_text": "fixture",
                                         "target_project_id": other["project"], "match_count": 1, "rrf_k": 60}),
            ("claim_document_ingestion", {"p_document_id": other["document"], "p_lease": lease}),
            ("finish_document_ingestion", {"p_document_id": other["document"], "p_lease": lease, "p_chunks": []}),
            ("fail_document_ingestion", {"p_document_id": other["document"], "p_lease": lease,
                                         "p_error": "Probe", "p_retryable": False}),
        ):
            for token in (None, own["token"]):
                self.denied(self.request("POST", f"/rest/v1/rpc/{name}", token, json=body), f"Restricted RPC {name}")
        # The global recovery dispatcher is checked via SQL grants, never invoked against shared staging data.

    def anonymous_checks(self):
        fixture = self.users[0]
        for token in (None, "invalid-token"):
            for method, path, body, params in (
                ("GET", "/api/projects", None, None),
                ("POST", "/api/projects", {"name": "Unauthorized"}, None),
                ("GET", "/api/documents", None, {"projectId": fixture["project"]}),
                ("DELETE", "/api/documents", None, {"documentId": fixture["document"]}),
                ("POST", "/api/documents/upload-url", {"projectId": fixture["project"], "filename": "authz.txt", "fileSize": 5}, None),
                ("POST", "/api/feedback", {"interactionId": fixture["interaction"], "rating": "thumbs_down"}, None),
                ("POST", "/api/chat", {"projectId": fixture["project"], "query": "Probe"}, None),
                ("POST", "/api/webhooks/storage", {"storagePath": fixture["path"]}, None),
            ):
                self.expect(self.request(method, path, token, app=True, json=body, params=params), 401, "Invalid/absent authentication")

    def verify_unchanged(self):
        for user in self.users:
            require(len(self.rows("projects", self.service, id=user["project"], user_id=user["id"])) == 1, "Project ownership preserved")
            docs = self.rows("documents", self.service, project_id=user["project"])
            require(len(docs) == 1 and docs[0]["id"] == user["document"] and docs[0]["status"] == "indexed", "Documents unchanged")
            require(len(self.rows("document_chunks", self.service, project_id=user["project"])) == 1, "Chunks unchanged")
            rows = self.rows("interactions", self.service, project_id=user["project"])
            require(len(rows) == 1 and rows[0]["response_markdown"] == "Fixture answer"
                    and rows[0]["feedback"]["rating"] == "thumbs_up", "Telemetry and feedback preserved")

    def run(self):
        self.setup()
        self.anonymous_checks()
        for own, other in (self.users, self.users[::-1]):
            before = self.snapshot(other)
            self.app_checks(own, other)
            self.database_checks(own, other)
            self.storage_checks(own, other)
            self.rpc_checks(own, other)
            require(self.snapshot(other) == before, "Foreign fixture changed during denied operations")
        # Check after BOTH directions: the second attacker must not corrupt the first owner's feedback.
        self.verify_unchanged()
        for user in self.users:
            self.expect(self.request("DELETE", "/api/documents", user["token"], app=True,
                                     params={"documentId": user["document"]}), 200, "Owner document delete works")
            require(self.rows("documents", self.service, id=user["document"]) == []
                    and self.rows("document_chunks", self.service, document_id=user["document"]) == [], "Document deletion cascades")
            response = self.request("GET", f"/storage/v1/object/authenticated/documents/{user['path']}", self.service)
            require(response.status_code in (400, 404), "Owner document deletion must remove Storage object")

    def snapshot(self, user):
        return {table: self.rows(table, self.service, **filters) for table, filters in (
            ("projects", {"id": user["project"]}), ("documents", {"project_id": user["project"]}),
            ("document_chunks", {"project_id": user["project"]}), ("interactions", {"project_id": user["project"]}))}

    def cleanup(self):
        failures = []
        # Attempt every cleanup even after a probe or an earlier cleanup fails.
        operations = []
        if self.paths:
            operations.append(("DELETE", "/storage/v1/object/documents", {"json": {"prefixes": self.paths}}))
        for user in self.users:
            operations.append(("DELETE", "/rest/v1/projects", {"params": {"user_id": f"eq.{user['id']}"}}))
        for user in self.users:
            operations.append(("DELETE", f"/auth/v1/admin/users/{user['id']}", {}))
        for method, path, kwargs in operations:
            try:
                response = self.request(method, path, self.service, **kwargs)
                if response.status_code not in (200, 204):
                    failures.append(f"HTTP {response.status_code}")
            except CheckFailed:
                failures.append("network error")
        return failures


def main():
    suite = None
    success = False
    try:
        suite = BoundaryChecks(*configuration())
        suite.run()
        success = True
    except CheckFailed as error:
        print(f"FAIL: {error}")
    except (ValueError, KeyError, TypeError):
        print("FAIL: Unexpected API response; response content omitted to protect credentials.")
    finally:
        if suite:
            failures = suite.cleanup()
            if failures:
                print(f"FAIL: {len(failures)} fixture cleanup operations failed; inspect staging for authz- users.")
                success = False
    if success:
        print(f"PASS: {suite.passed} HTTP boundary assertions; both users, anonymous callers, RLS, Storage and scoped RPCs.")
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
