"""Phở research agent over plain REST, no MCP. Python standard library only.

    export PHO_API_KEY=pho_sk_...       # https://pho.chat/settings -> API keys
    python rest.py "SGLT2 inhibitors and heart failure hospitalisation" > report.md

Full API reference: https://api.pho.chat/v1/openapi.json
"""

import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request

API = "https://api.pho.chat/v1"
KEY = os.environ["PHO_API_KEY"]


def call(method: str, path: str, body=None, headers=None):
    req = urllib.request.Request(
        API + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            raw = res.read().decode()
            return json.loads(raw) if "json" in res.headers.get("Content-Type", "") else raw
    except urllib.error.HTTPError as e:
        err = json.loads(e.read() or b"{}").get("error", {})
        sys.exit(f"Phở API {e.code} {err.get('code')}: {err.get('message')}")


def main(question: str) -> None:
    # Same Idempotency-Key => same run, so a crashed script can be re-run safely.
    idem = "rest-" + hashlib.sha256(question.encode()).hexdigest()[:32]
    run = call("POST", "/runs", {"agent": "research-writer", "input": question, "locale": "en"}, {"Idempotency-Key": idem})
    print(f"run {run['id']} {run['status']} ({run['credential_source']})", file=sys.stderr)

    while run["status"] not in ("completed", "failed", "cancelled", "needs_user_input"):
        time.sleep(10)
        run = call("GET", f"/runs/{run['id']}")
        print(f"  {run['status']}", file=sys.stderr)

    if run["status"] != "completed":
        sys.exit(f"run ended as {run['status']}: {run.get('error')}")
    for artifact in run["artifacts"]:
        print(call("GET", f"/artifacts/{artifact['id']}?format=markdown", headers={"Accept": "text/markdown"}))
        return
    sys.exit("run completed without a report")


if __name__ == "__main__":
    main(" ".join(sys.argv[1:]) or "Metformin and colorectal cancer incidence")
