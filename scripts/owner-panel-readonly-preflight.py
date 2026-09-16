"""Fixed-target inventory only. No deployment, schema apply, or decision writes."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.request

REPO = "rozkalnsandris/rozkalns-control-center"
ACCOUNT = "70e29dbca0e8363358659102d2b74178"
DB = "8504e986-faf0-450c-bfb5-41b5dbf8be09"
WORKER = "rozkalns-control"
ORIGIN = "https://control.rozkalns.net"
CF = "https://api.cloudflare.com/client/v4/accounts/" + ACCOUNT
GH = "https://api.github.com/repos/" + REPO
TARGET_BINDINGS = {
    "CONTROL_CONTINUATION_RUNTIME_ENABLED",
    "CONTROL_CONTINUATION_ACCESS_ISSUER",
    "CONTROL_CONTINUATION_ACCESS_AUDIENCE",
}
EXPECTED_ISSUER = "https://super-salad-2357.cloudflareaccess.com"
MIGRATIONS = "SELECT name FROM d1_migrations ORDER BY id LIMIT 100"
SCHEMA = ("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name IN "
          "('continuation_campaigns','continuation_tasks','continuation_action_audit') ORDER BY name")
CAMPAIGNS = ("SELECT COUNT(*) AS campaign_count, "
             "SUM(CASE WHEN EXISTS (SELECT 1 FROM continuation_tasks t WHERE "
             "t.campaign_id = c.campaign_id AND t.task_id = c.current_task_id "
             "AND t.active_pull_request_number IS NOT NULL) THEN 1 ELSE 0 END) AS linked_count "
             "FROM continuation_campaigns c")
SQL_ALLOWLIST = frozenset((MIGRATIONS, SCHEMA, CAMPAIGNS))


FAILURE_CODES = frozenset((
    "DEPLOYMENTS_INVALID",
    "BASELINE_NOT_SINGLE_VERSION",
    "BASELINE_NOT_100_PERCENT",
    "BINDINGS_INVALID",
    "DUPLICATE_BINDING",
    "D1_RESPONSE_INVALID",
    "D1_ZERO_WRITES_NOT_PROVEN",
    "SCHEMA_INVALID",
    "SCHEMA_DUPLICATE",
    "SOURCE_SCHEMA_INVALID",
    "URL_NOT_ALLOWED",
    "SQL_NOT_ALLOWED",
    "ACCESS_DESTINATION_INVALID",
    "RESPONSE_TOO_LARGE",
    "MAIN_DISPATCH_REQUIRED",
    "SHA_INVALID",
    "REQUIRED_READ_CREDENTIAL_ABSENT",
    "CF_RESPONSE_INVALID",
    "MAIN_DRIFT",
    "EXACT_MAIN_CI_MISSING",
    "EXACT_MAIN_CI_NOT_PASS",
    "VERSION_DRIFT",
    "D1_IDENTITY_INVALID",
    "MIGRATION_HISTORY_AMBIGUOUS",
    "CAMPAIGN_COUNT_INVALID",
    "HEALTH_IDENTITY_INVALID",
    "UI_SHELL_INVALID",
    "FINAL_MAIN_DRIFT",
    "FINAL_DEPLOYMENT_DRIFT",
))
STAGES = frozenset(("ENVIRONMENT", "GITHUB_MAIN", "GITHUB_CI", "WORKER_DEPLOYMENTS",
                    "WORKER_VERSION_BINDINGS", "D1_IDENTITY", "D1_MIGRATIONS",
                    "D1_SCHEMA", "D1_CAMPAIGNS", "WORKER_HEALTH", "UI_SHELL",
                    "FINAL_MAIN", "FINAL_DEPLOYMENT"))


class PreflightError(ValueError):
    """Only locally defined contract codes may enter the public receipt."""


def require(ok, code):
    if not ok:
        raise PreflightError(code)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def uuid(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", value) is not None


def baseline(payload):
    deployments = payload.get("deployments")
    require(isinstance(deployments, list) and deployments, "DEPLOYMENTS_INVALID")
    active = deployments[0]
    versions = active.get("versions")
    require(uuid(active.get("id")) and isinstance(versions, list) and len(versions) == 1,
            "BASELINE_NOT_SINGLE_VERSION")
    require(uuid(versions[0].get("version_id")) and versions[0].get("percentage") == 100,
            "BASELINE_NOT_100_PERCENT")
    return active["id"], versions[0]["version_id"]


def binding_inventory(bindings):
    require(isinstance(bindings, list), "BINDINGS_INVALID")
    require(all(isinstance(b, dict) and isinstance(b.get("name"), str) for b in bindings), "BINDINGS_INVALID")
    require(len({b["name"] for b in bindings}) == len(bindings), "DUPLICATE_BINDING")
    by_name = {b["name"]: b for b in bindings}
    result = {}
    expected = {
        "CONTROL_CONTINUATION_RUNTIME_ENABLED": "true",
        "CONTROL_CONTINUATION_ACCESS_ISSUER": EXPECTED_ISSUER,
        "GITHUB_APP_CLIENT_ID": "Iv23likDoFtVeWBJfdFS",
        "GITHUB_APP_INSTALLATION_ID": "153121564",
    }
    for name, value in expected.items():
        b = by_name.get(name)
        result[name] = "ABSENT" if b is None else "MATCH" if b.get("type") == "plain_text" and b.get("text") == value else "DIFFERENT"
    audience = by_name.get("CONTROL_CONTINUATION_ACCESS_AUDIENCE")
    result["CONTROL_CONTINUATION_ACCESS_AUDIENCE"] = (
        "ABSENT" if audience is None else "PRESENT_UNVERIFIED"
        if audience.get("type") == "plain_text" and isinstance(audience.get("text"), str)
        and re.fullmatch(r"[A-Za-z0-9._:+/-]{1,200}", audience["text"]) else "INVALID"
    )
    # Only a separately verified human-only Access application can prove audience.
    private_key = by_name.get("GITHUB_APP_PRIVATE_KEY_PEM", {})
    result["GITHUB_APP_PRIVATE_KEY_PEM"] = "PRESENT_PROTECTED" if private_key.get("type") in ("secret_text", "secret_key") else "ABSENT_OR_INVALID"
    db = by_name.get("CONTROL_DB", {})
    result["CONTROL_DB"] = "MATCH" if db.get("type") == "d1" and db.get("database_id", db.get("id")) == DB else "ABSENT_OR_INVALID"
    # Metadata digest only. Never return secret values or other bindings.
    result["non_target_bindings_sha256"] = digest(sorted(
        [b for b in bindings if b["name"] not in TARGET_BINDINGS], key=lambda b: b["name"]))
    return result


def select_rows(payload):
    require(payload.get("success") is True and isinstance(payload.get("result"), list)
            and len(payload["result"]) == 1, "D1_RESPONSE_INVALID")
    result = payload["result"][0]
    meta = result.get("meta", {})
    require(result.get("success") is True and isinstance(result.get("results"), list), "D1_RESPONSE_INVALID")
    require(meta.get("changed_db") is False and meta.get("rows_written") == 0 and meta.get("changes", 0) == 0,
            "D1_ZERO_WRITES_NOT_PROVEN")
    return result["results"]


def normalize_sql(sql):
    return re.sub(r"\s+", " ", sql.strip().rstrip(";")).lower()


def schema_inventory(rows, migration_names, root):
    require(all(isinstance(r, dict) and isinstance(r.get("name"), str) and isinstance(r.get("sql"), str) for r in rows),
            "SCHEMA_INVALID")
    require(len({r["name"] for r in rows}) == len(rows), "SCHEMA_DUPLICATE")
    expected = {}
    for filename in ("0007_continuation_campaigns.sql", "0014_continuation_action_audit.sql"):
        source = (root / "migrations" / filename).read_text()
        for name, statement in re.findall(r"(?:CREATE TABLE)\s+(\w+)\s*(\([\s\S]*?;)", source):
            expected[name] = normalize_sql("CREATE TABLE " + name + " " + statement)
    require(len(expected) == 3, "SOURCE_SCHEMA_INVALID")
    observed = {r["name"]: normalize_sql(r["sql"]) for r in rows}
    result = {name: "ABSENT" if name not in observed else "MATCH" if observed[name] == sql else "DIFFERENT"
              for name, sql in expected.items()}
    result["migration_0007_recorded"] = "0007_continuation_campaigns.sql" in migration_names
    result["migration_0014_recorded"] = "0014_continuation_action_audit.sql" in migration_names
    result["migration_0014_sha256"] = hashlib.sha256((root / "migrations/0014_continuation_action_audit.sql").read_bytes()).hexdigest()
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(url, token, sql=None, access=None, html=False):
    allowed = {GH + "/branches/main", GH + "/actions/workflows/ci.yml/runs?event=push&branch=main&per_page=10",
               CF + "/workers/scripts/" + WORKER + "/deployments", CF + "/d1/database/" + DB,
               CF + "/d1/database/" + DB + "/query", ORIGIN + "/api/health", ORIGIN + "/"}
    version_path = CF + "/workers/scripts/" + WORKER + "/versions/"
    require(url in allowed or (url.startswith(version_path) and uuid(url[len(version_path):])), "URL_NOT_ALLOWED")
    require(sql is None or (url == CF + "/d1/database/" + DB + "/query" and sql in SQL_ALLOWLIST), "SQL_NOT_ALLOWED")
    headers = {"Accept": "application/json", "Cache-Control": "no-store"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if access:
        require(url in (ORIGIN + "/api/health", ORIGIN + "/"), "ACCESS_DESTINATION_INVALID")
        headers.update({"CF-Access-Client-Id": access[0], "CF-Access-Client-Secret": access[1]})
    data = None if sql is None else json.dumps({"sql": sql}).encode()
    if data:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method="GET" if sql is None else "POST")
    with urllib.request.build_opener(NoRedirect).open(req, timeout=30) as response:
        raw = response.read(2_000_001)
        require(len(raw) <= 2_000_000, "RESPONSE_TOO_LARGE")
        return raw if html else json.loads(raw)


def run(env, root, read=request, diagnostic=None):
    diagnostic = {} if diagnostic is None else diagnostic
    diagnostic["stage"] = "ENVIRONMENT"
    require(env.get("GITHUB_EVENT_NAME") == "workflow_dispatch" and env.get("GITHUB_REF_NAME") == "main",
            "MAIN_DISPATCH_REQUIRED")
    sha = env.get("GITHUB_SHA", "")
    require(re.fullmatch(r"[0-9a-f]{40}", sha), "SHA_INVALID")
    for name in ("GITHUB_TOKEN", "CLOUDFLARE_WORKERS_READ_TOKEN", "CLOUDFLARE_D1_READ_TOKEN"):
        require(bool(env.get(name)), "REQUIRED_READ_CREDENTIAL_ABSENT")
    gh = lambda path: read(GH + path, env["GITHUB_TOKEN"])
    def cf(path, d1=False):
        payload = read(CF + path, env["CLOUDFLARE_D1_READ_TOKEN" if d1 else "CLOUDFLARE_WORKERS_READ_TOKEN"])
        require(payload.get("success") is True, "CF_RESPONSE_INVALID")
        return payload["result"]
    def select(sql):
        return select_rows(read(CF + "/d1/database/" + DB + "/query", env["CLOUDFLARE_D1_READ_TOKEN"], sql=sql))
    diagnostic["stage"] = "GITHUB_MAIN"
    require(gh("/branches/main")["commit"]["sha"] == sha, "MAIN_DRIFT")
    diagnostic["stage"] = "GITHUB_CI"
    runs = gh("/actions/workflows/ci.yml/runs?event=push&branch=main&per_page=10")["workflow_runs"]
    matches = [r for r in runs if r.get("head_sha") == sha and r.get("event") == "push"
               and r.get("head_branch") == "main" and r.get("path") == ".github/workflows/ci.yml"]
    require(bool(matches), "EXACT_MAIN_CI_MISSING")
    latest = max(matches, key=lambda r: r["run_number"])
    require(latest.get("status") == "completed" and latest.get("conclusion") == "success", "EXACT_MAIN_CI_NOT_PASS")
    diagnostic["stage"] = "WORKER_DEPLOYMENTS"
    deployment, version = baseline(cf("/workers/scripts/" + WORKER + "/deployments"))
    diagnostic["stage"] = "WORKER_VERSION_BINDINGS"
    details = cf("/workers/scripts/" + WORKER + "/versions/" + version)
    require(details.get("id") == version, "VERSION_DRIFT")
    bindings = binding_inventory(details["resources"]["bindings"])
    diagnostic["stage"] = "D1_IDENTITY"
    database = cf("/d1/database/" + DB, d1=True)
    require(database.get("uuid") == DB and database.get("name") == "rozkalns-control-production"
            and database.get("jurisdiction") == "eu", "D1_IDENTITY_INVALID")
    diagnostic["stage"] = "D1_MIGRATIONS"
    names = [r["name"] for r in select(MIGRATIONS)]
    require(len(names) < 100 and len(names) == len(set(names)), "MIGRATION_HISTORY_AMBIGUOUS")
    diagnostic["stage"] = "D1_SCHEMA"
    schema = schema_inventory(select(SCHEMA), names, root)
    counts = "NOT_READ_SCHEMA_UNAVAILABLE"
    if schema["continuation_campaigns"] == schema["continuation_tasks"] == "MATCH":
        diagnostic["stage"] = "D1_CAMPAIGNS"
        rows = select(CAMPAIGNS)
        require(len(rows) == 1, "CAMPAIGN_COUNT_INVALID")
        counts = rows[0]
        require(set(counts) == {"campaign_count", "linked_count"} and
                all(v is None or (type(v) is int and v >= 0) for v in counts.values()), "CAMPAIGN_COUNT_INVALID")
    health = "NOT_PROVEN_ACCESS_CREDENTIALS_ABSENT"
    ui = "NOT_PROVEN_ACCESS_CREDENTIALS_ABSENT"
    if env.get("CONTROL_ACCESS_CLIENT_ID") and env.get("CONTROL_ACCESS_CLIENT_SECRET"):
        access = (env["CONTROL_ACCESS_CLIENT_ID"], env["CONTROL_ACCESS_CLIENT_SECRET"])
        diagnostic["stage"] = "WORKER_HEALTH"
        observed = read(ORIGIN + "/api/health", None, access=access)
        require(observed.get("status") == "ok" and observed.get("service") == WORKER
                and observed.get("workerVersion") == version, "HEALTH_IDENTITY_INVALID")
        health = "MATCH"
        diagnostic["stage"] = "UI_SHELL"
        page = read(ORIGIN + "/", None, access=access, html=True)
        require(b'id="root"' in page and b"<script" in page, "UI_SHELL_INVALID")
        ui = {"shell_sha256": hashlib.sha256(page).hexdigest(), "seven_action_runtime": "NOT_PROVEN_BY_HTML"}
    diagnostic["stage"] = "FINAL_MAIN"
    require(gh("/branches/main")["commit"]["sha"] == sha, "FINAL_MAIN_DRIFT")
    diagnostic["stage"] = "FINAL_DEPLOYMENT"
    require(baseline(cf("/workers/scripts/" + WORKER + "/deployments")) == (deployment, version),
            "FINAL_DEPLOYMENT_DRIFT")
    return {"schema_version": 1, "source_sha": sha, "ci_run_id": latest["id"],
            "observed_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "deployment": deployment, "version": version, "bindings": bindings, "d1": schema,
            "campaign_counts": counts, "health": health, "ui": ui,
            "access_owner_policy": "NOT_PROVEN_BY_BINDING_MATCH",
            "github_read_credential_usability": "NOT_PROVEN_BY_SECRET_METADATA",
            "retry_ci": "DISABLED_SEPARATE_PERMISSION_GATE",
            "production_mutations": 0, "activation_ready": False,
            "next_gate": "REVIEW_READONLY_EVIDENCE_AND_BOUND_LIVE_SCOPE"}


def failure_receipt(error, diagnostic):
    # Never stringify exceptions, URLs, bodies, headers or provider messages.
    code = "UNEXPECTED_ERROR"
    status = None
    if isinstance(error, PreflightError):
        code = error.args[0] if len(error.args) == 1 and type(error.args[0]) is str and error.args[0] in FAILURE_CODES else "CONTRACT_ERROR"
    elif isinstance(error, urllib.error.HTTPError):
        code = "HTTP_ERROR"
        status = error.code if type(error.code) is int and 300 <= error.code <= 599 else None
    elif isinstance(error, TimeoutError):
        code = "NETWORK_TIMEOUT"
    elif isinstance(error, urllib.error.URLError):
        code = "NETWORK_ERROR"
    elif isinstance(error, (json.JSONDecodeError, UnicodeDecodeError)):
        code = "RESPONSE_DECODE_ERROR"
    elif isinstance(error, (KeyError, TypeError, AttributeError, IndexError)):
        code = "RESPONSE_SHAPE_INVALID"
    elif isinstance(error, OSError):
        code = "IO_ERROR"
    stage = diagnostic.get("stage")
    return {"preflight": "STOP", "reason": "READONLY_EVIDENCE_FAILED_CLOSED",
            "stage": stage if type(stage) is str and stage in STAGES else "UNKNOWN",
            "code": code, "http_status": status,
            "production_mutations": 0, "activation_ready": False}


def main(env, root, read=request):
    diagnostic = {}
    try:
        receipt = run(env, root, read, diagnostic)
    except Exception as error:
        print(json.dumps(failure_receipt(error, diagnostic), sort_keys=True))
        return 1
    print(json.dumps(receipt, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main(os.environ, Path(__file__).resolve().parents[1]))
