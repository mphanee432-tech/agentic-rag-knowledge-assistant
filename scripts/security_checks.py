"""Read-only, two-user authorization checks for a running staging application."""
import os
import requests
from urllib.parse import urlsplit

def check_isolation(endpoint, auth=None):
    token_b = os.getenv("EVAL_OTHER_ACCESS_TOKEN", "").strip()
    if not token_b:
        return False, "Missing second-user access token."
    token_a = auth.get_token() if auth is not None else os.getenv("EVAL_ACCESS_TOKEN")
    project_a = os.getenv("EVAL_PROJECT_ID")
    project_b = os.getenv("EVAL_OTHER_PROJECT_ID")
    if not all([token_a, token_b, project_a, project_b]) or project_a == project_b:
        return False, "Missing distinct two-user project fixtures."
    url = urlsplit(endpoint)
    base = f"{url.scheme}://{url.netloc}"
    try:
        for token, own, other in [(token_a, project_a, project_b), (token_b, project_b, project_a)]:
            headers = {"Authorization": f"Bearer {token}"}

            def request(send, url, **kwargs):
                if auth is not None and token == token_a:
                    return auth.request(send, url, **kwargs)
                return send(url, allow_redirects=False, **kwargs)

            response = request(requests.get, f"{base}/api/projects", params={"id": own}, headers=headers, timeout=15)
            if response.status_code != 200 or response.json().get("project", {}).get("id") != own:
                return False, "Own-project fixture could not be verified."
            for path, params in [("/api/projects", {"id": other}), ("/api/documents", {"projectId": other})]:
                response = request(requests.get, base + path, params=params, headers=headers, timeout=15)
                if response.status_code != 404:
                    return False, "A foreign project was not denied."
            response = request(requests.post, endpoint, headers=headers,
                                     json={"projectId": other, "query": "Authorization test", "stream": False}, timeout=15)
            if response.status_code != 404:
                return False, "Cross-project chat was not denied before generation."
        response = requests.get(f"{base}/api/projects", timeout=15, allow_redirects=False)
        if response.status_code != 401:
            return False, "Anonymous project listing was not denied."
        return True, "Two-user read and chat isolation checks passed."
    except (requests.RequestException, ValueError):
        return False, "Isolation checks could not complete."

