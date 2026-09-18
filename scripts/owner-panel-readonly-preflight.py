"""Fixed-target inventory only. No deployment, schema apply, or decision writes."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

REPO = "rozkalnsandris/rozkalns-control-center"
ACCOUNT = "70e29dbca0e8363358659102d2b74178"
DB = "8504e986-faf0-450c-bfb5-41b5dbf8be09"
WORKER = "rozkalns-control"
ORIGIN = "https://control.rozkalns.net"
CF = "https://api.cloudflare.com/client/v4/accounts/" + ACCOUNT
GH = "https://api.github.com/repos/" + REPO
ACCESS = CF + "/access"
GRAPHQL = "https://api.cloudflare.com/client/v4/graphql"
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
HEALTH_DIAGNOSTIC_MAX_BYTES = 65_536
HEALTH_ACCESS_RESPONSE_CLASSES = frozenset((
    "BODY_TOO_LARGE",
    "BODY_UNAVAILABLE",
    "NON_JSON",
    "JSON_NOT_WORKER_ACCESS_AUTH_SCHEMA",
    "WORKER_ACCESS_AUTHENTICATION_FAILED",
    "WORKER_ACCESS_AUTHENTICATION_FAILED_UNRECOGNIZED_DIAGNOSTIC",
    "WORKER_ACCESS_JWT_AUDIENCE_INVALID",
    "WORKER_ACCESS_JWT_CLAIMS_INVALID",
    "WORKER_ACCESS_JWT_EXPIRED",
    "WORKER_ACCESS_JWT_HEADER_INVALID",
    "WORKER_ACCESS_JWT_HUMAN_REQUIRED",
    "WORKER_ACCESS_JWT_ISSUED_IN_FUTURE",
    "WORKER_ACCESS_JWT_ISSUER_INVALID",
    "WORKER_ACCESS_JWT_KEY_INVALID",
    "WORKER_ACCESS_JWT_KEY_UNAVAILABLE",
    "WORKER_ACCESS_JWT_MALFORMED",
    "WORKER_ACCESS_JWT_MISSING",
    "WORKER_ACCESS_JWT_NOT_YET_VALID",
    "WORKER_ACCESS_JWT_SIGNATURE_INVALID",
))
ACCESS_POLICY_DIAGNOSTICS = frozenset((
    "NOT_PROVEN_ACCESS_READ_CREDENTIAL_ABSENT",
    "NOT_PROVEN_ACCESS_READ_FAILED",
    "NOT_PROVEN_SEPARATE_READ_SCOPE",
    "NOT_PROVEN_NO_SERVICE_TOKEN_SELECTOR",
    "NOT_PROVEN_ACCESS_CLIENT_ID_ABSENT",
    "NOT_PROVEN_SERVICE_TOKEN_SELECTOR_INVALID",
    "NOT_PROVEN_SERVICE_TOKENS_READ_DENIED",
    "NOT_PROVEN_SERVICE_TOKENS_READ_FAILED",
    "NOT_PROVEN_SERVICE_TOKEN_CLIENT_ID_NOT_LISTED",
    "NOT_PROVEN_SERVICE_TOKEN_NOT_SELECTED",
    "NOT_PROVEN_SERVICE_TOKEN_DISABLED",
    "PROVEN_SERVICE_TOKEN_SELECTOR_MATCH_ENABLED",
))
SERVICE_TOKEN_POLICY_ELIGIBILITY = frozenset((
    "NOT_PROVEN_SERVICE_TOKEN_MATCH",
    "NOT_PROVEN_SELECTED_SERVICE_TOKEN_POLICY_INVALID",
    "NOT_PROVEN_SELECTED_SERVICE_TOKEN_POLICY_NOT_SERVICE_AUTH",
    "NOT_PROVEN_SELECTED_SERVICE_TOKEN_POLICY_CONSTRAINED",
    "PROVEN_ENABLED_SERVICE_AUTH_POLICY_UNCONSTRAINED",
))
WORKER_DOMAIN_DIAGNOSTICS = frozenset((
    "NOT_PROVEN_CUSTOM_DOMAIN_READ_CREDENTIAL_ABSENT",
    "NOT_PROVEN_CUSTOM_DOMAIN_READ_FAILED",
    "NOT_PROVEN_CUSTOM_DOMAIN_UNMAPPED",
    "NOT_PROVEN_CUSTOM_DOMAIN_SERVICE_MISMATCH",
    "PROVEN_CUSTOM_DOMAIN_SERVICE_MATCH",
))
ACCESS_EVENT_DIAGNOSTICS = frozenset((
    "NOT_PROVEN_ANALYTICS_READ_CREDENTIAL_ABSENT",
    "NOT_PROVEN_CF_RAY_HEADER_ABSENT_OR_INVALID",
    "NOT_PROVEN_GRAPHQL_ACCESS_EVENT_READ_FAILED",
    "NOT_PROVEN_ANALYTICS_TOKEN_INVALID",
    "PROVEN_ACCOUNT_ANALYTICS_READ_MISSING",
    "NOT_PROVEN_GRAPHQL_RESPONSE_ERROR",
    "PROVEN_GRAPHQL_QUERY_MALFORMED",
    "PROVEN_GRAPHQL_DATASET_LIMIT",
    "PROVEN_GRAPHQL_RATE_LIMIT",
    "PROVEN_GRAPHQL_SERVICE_UNAVAILABLE",
    "PROVEN_GRAPHQL_ACCOUNT_NOT_AUTHORIZED",
    "PROVEN_GRAPHQL_ACCESS_LOGIN_EVENT_PATH",
    "PROVEN_GRAPHQL_ERROR_PATH_PRESENT_UNRECOGNIZED",
    "PROVEN_GRAPHQL_ERROR_PATH_KEY_ABSENT",
    "PROVEN_GRAPHQL_ERROR_PATH_NULL",
    "PROVEN_GRAPHQL_ERROR_PATH_PRESENT_INVALID_NON_NULL",
    "NOT_PROVEN_GRAPHQL_ERROR_PATH_ABSENT_OR_INVALID",
    "NOT_PROVEN_GRAPHQL_RESPONSE_INVALID",
    "NOT_PROVEN_ACCESS_EVENT_NOT_FOUND",
    "PROVEN_ACCESS_SERVICE_TOKEN_AUTHORIZED",
    "PROVEN_ACCESS_AUTHORIZED_NONIDENTITY_WITHOUT_SERVICE_TOKEN",
    "PROVEN_ACCESS_AUTHORIZED_NON_SERVICE_TOKEN",
    "PROVEN_ACCESS_NONIDENTITY_DENIED",
    "PROVEN_ACCESS_DENIED_NON_SERVICE_TOKEN",
))

ACCESS_LOGIN_EVENT_QUERY = """query accessLoginRequestsAdaptiveGroups(
  $accountTag: string, $rayId: string, $datetimeStart: string, $datetimeEnd: string
) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      accessLoginRequestsAdaptiveGroups(
        limit: 1
        filter: {datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd, cfRayId: $rayId}
        orderBy: [datetime_ASC]
      ) {
        dimensions { isSuccessfulLogin identityProvider serviceTokenId }
      }
    }
  }
}"""


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


def request(url, token, sql=None, access=None, html=False, graphql=None):
    allowed = {GH + "/branches/main", GH + "/actions/workflows/ci.yml/runs?event=push&branch=main&per_page=10",
               CF + "/workers/scripts/" + WORKER + "/deployments", CF + "/d1/database/" + DB,
               CF + "/d1/database/" + DB + "/query", worker_domains_url(),
               ORIGIN + "/api/health", ORIGIN + "/", GRAPHQL}
    version_path = CF + "/workers/scripts/" + WORKER + "/versions/"
    access_app_match = re.fullmatch(re.escape(ACCESS + "/apps") + r"\?per_page=100&page=([1-9]|10)", url)
    access_policy_match = re.fullmatch(
        re.escape(ACCESS + "/apps/") + r"([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/policies\?per_page=100&page=([1-9]|10)",
        url,
    )
    access_service_tokens_match = re.fullmatch(
        re.escape(ACCESS + "/service_tokens") + r"\?per_page=100&page=([1-9]|10)", url
    )
    require(url in allowed or (url.startswith(version_path) and uuid(url[len(version_path):]))
            or access_app_match is not None or access_policy_match is not None
            or access_service_tokens_match is not None, "URL_NOT_ALLOWED")
    require(url != GRAPHQL or graphql is not None, "URL_NOT_ALLOWED")
    require(sql is None or (url == CF + "/d1/database/" + DB + "/query" and sql in SQL_ALLOWLIST), "SQL_NOT_ALLOWED")
    require(graphql is None or (
        url == GRAPHQL and sql is None and access is None and not html
        and isinstance(graphql, dict) and set(graphql) == {"query", "variables"}
        and graphql.get("query") == ACCESS_LOGIN_EVENT_QUERY
        and isinstance(graphql.get("variables"), dict)
        and set(graphql["variables"]) == {"accountTag", "rayId", "datetimeStart", "datetimeEnd"}
        and graphql["variables"].get("accountTag") == ACCOUNT
        and all(isinstance(graphql["variables"].get(name), str) for name in
                ("rayId", "datetimeStart", "datetimeEnd"))
    ), "URL_NOT_ALLOWED")
    headers = {"Accept": "application/json", "Cache-Control": "no-store"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if access:
        require(url in (ORIGIN + "/api/health", ORIGIN + "/"), "ACCESS_DESTINATION_INVALID")
        headers.update({"CF-Access-Client-Id": access[0], "CF-Access-Client-Secret": access[1]})
    data = (json.dumps(graphql, separators=(",", ":")).encode() if graphql is not None else
            None if sql is None else json.dumps({"sql": sql}).encode())
    if data:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers,
                                 method="POST" if sql is not None or graphql is not None else "GET")
    with urllib.request.build_opener(NoRedirect).open(req, timeout=30) as response:
        raw = response.read(2_000_001)
        require(len(raw) <= 2_000_000, "RESPONSE_TOO_LARGE")
        return raw if html else json.loads(raw)


def access_apps_url(page):
    require(type(page) is int and 1 <= page <= 10, "URL_NOT_ALLOWED")
    return ACCESS + "/apps?per_page=100&page=" + str(page)


def access_app_policies_url(app_id, page):
    require(uuid(app_id) and type(page) is int and 1 <= page <= 10, "URL_NOT_ALLOWED")
    return ACCESS + "/apps/" + app_id + "/policies?per_page=100&page=" + str(page)


def access_service_tokens_url(page):
    require(type(page) is int and 1 <= page <= 10, "URL_NOT_ALLOWED")
    return ACCESS + "/service_tokens?per_page=100&page=" + str(page)


def access_pages(read, token, make_url):
    rows = []
    for page in range(1, 11):
        payload = read(make_url(page), token)
        require(payload.get("success") is True and isinstance(payload.get("result"), list), "CF_RESPONSE_INVALID")
        current = payload["result"]
        require(len(current) <= 100, "CF_RESPONSE_INVALID")
        rows.extend(current)
        require(len(rows) <= 1_000, "CF_RESPONSE_INVALID")
        if len(current) < 100:
            return rows
    raise PreflightError("CF_RESPONSE_INVALID")


def access_public_destinations(app):
    destinations = app.get("destinations") if isinstance(app, dict) else None
    if isinstance(destinations, list) and destinations:
        values = [d.get("uri") for d in destinations
                  if isinstance(d, dict) and d.get("type", "public") == "public"]
    else:
        values = [app.get("domain")] if isinstance(app, dict) else []
    normalized = []
    for value in values:
        if not isinstance(value, str) or not 0 < len(value) <= 512:
            continue
        value = re.sub(r"^https?://", "", value.strip(), flags=re.IGNORECASE).rstrip("/")
        if not value or "?" in value or "#" in value:
            continue
        host, separator, path = value.partition("/")
        host = host.lower()
        if host not in ("control.rozkalns.net", "*.rozkalns.net"):
            continue
        normalized.append((host, "/" + path if separator else ""))
    return normalized


def health_access_match_score(app):
    if not isinstance(app, dict) or app.get("type") != "self_hosted" or not uuid(app.get("id")):
        return None
    scores = []
    for host, path in access_public_destinations(app):
        pattern = path or "/*"
        if re.fullmatch(re.escape(pattern).replace(r"\*", ".*"), "/api/health") is None:
            continue
        scores.append(len(host.replace("*", "")) + len(pattern.replace("*", "")))
    return max(scores, default=None)


def service_token_selector(policy):
    includes = policy.get("include") if isinstance(policy, dict) else None
    return isinstance(includes, list) and any(
        isinstance(rule, dict) and ("service_token" in rule or "any_valid_service_token" in rule)
        for rule in includes
    )


def service_token_policy_selectors(policies):
    any_valid = False
    token_ids = set()
    invalid = False
    for policy in policies:
        includes = policy.get("include") if isinstance(policy, dict) else None
        if not isinstance(includes, list):
            continue
        for rule in includes:
            if not isinstance(rule, dict):
                continue
            if "any_valid_service_token" in rule:
                any_valid = True
            if "service_token" in rule:
                selector = rule["service_token"]
                token_id = selector.get("token_id") if isinstance(selector, dict) else None
                if uuid(token_id):
                    token_ids.add(token_id)
                else:
                    invalid = True
    return any_valid, token_ids, invalid


def service_token_match_detail(policies, access_client_id, access_read_token, read):
    any_valid, token_ids, invalid = service_token_policy_selectors(policies)
    if not any_valid and not token_ids:
        return ("NOT_PROVEN_SERVICE_TOKEN_SELECTOR_INVALID" if invalid else
                "NOT_PROVEN_NO_SERVICE_TOKEN_SELECTOR"), frozenset()
    if invalid or not access_client_id:
        return ("NOT_PROVEN_SERVICE_TOKEN_SELECTOR_INVALID" if invalid else
                "NOT_PROVEN_ACCESS_CLIENT_ID_ABSENT"), frozenset()
    try:
        tokens = access_pages(read, access_read_token, access_service_tokens_url)
    except urllib.error.HTTPError as error:
        return ("NOT_PROVEN_SERVICE_TOKENS_READ_DENIED" if error.code in (401, 403) else
                "NOT_PROVEN_SERVICE_TOKENS_READ_FAILED"), frozenset()
    except (PreflightError, urllib.error.URLError, TimeoutError, json.JSONDecodeError,
            UnicodeDecodeError, KeyError, TypeError, AttributeError, IndexError, OSError):
        return "NOT_PROVEN_SERVICE_TOKENS_READ_FAILED", frozenset()
    if not all(isinstance(token, dict) and uuid(token.get("id"))
               and isinstance(token.get("client_id"), str) and type(token.get("enabled")) is bool
               for token in tokens):
        return "NOT_PROVEN_SERVICE_TOKENS_READ_FAILED", frozenset()
    client_tokens = [token for token in tokens if token["client_id"] == access_client_id]
    if not client_tokens:
        return "NOT_PROVEN_SERVICE_TOKEN_CLIENT_ID_NOT_LISTED", frozenset()
    selected = [token for token in client_tokens if any_valid or token["id"] in token_ids]
    if not selected:
        return "NOT_PROVEN_SERVICE_TOKEN_NOT_SELECTED", frozenset()
    enabled_selected_ids = frozenset(token["id"] for token in selected if token["enabled"])
    return ("PROVEN_SERVICE_TOKEN_SELECTOR_MATCH_ENABLED", enabled_selected_ids) if enabled_selected_ids else (
        "NOT_PROVEN_SERVICE_TOKEN_DISABLED", frozenset())


def service_token_match(policies, access_client_id, access_read_token, read):
    return service_token_match_detail(policies, access_client_id, access_read_token, read)[0]


def policy_rule_state(policy, name):
    value = policy.get(name)
    if value is None:
        return "EMPTY"
    if not isinstance(value, list):
        return "INVALID"
    return "EMPTY" if not value else "NONEMPTY"


def selected_service_token_policy_eligibility(policies, service_token_match, enabled_selected_ids):
    if service_token_match != "PROVEN_SERVICE_TOKEN_SELECTOR_MATCH_ENABLED" or not enabled_selected_ids:
        return "NOT_PROVEN_SERVICE_TOKEN_MATCH"
    selected_policies = []
    for policy in policies:
        any_valid, token_ids, invalid = service_token_policy_selectors([policy])
        if invalid:
            return "NOT_PROVEN_SELECTED_SERVICE_TOKEN_POLICY_INVALID"
        if any_valid or token_ids.intersection(enabled_selected_ids):
            selected_policies.append(policy)
    if not selected_policies:
        return "NOT_PROVEN_SELECTED_SERVICE_TOKEN_POLICY_INVALID"
    service_auth_policies = [
        policy for policy in selected_policies
        if policy.get("decision", policy.get("action")) in ("non_identity", "service_auth")
    ]
    if not service_auth_policies:
        return "NOT_PROVEN_SELECTED_SERVICE_TOKEN_POLICY_NOT_SERVICE_AUTH"
    rule_states = [
        (policy_rule_state(policy, "require"), policy_rule_state(policy, "exclude"))
        for policy in service_auth_policies
    ]
    if any(require == exclude == "EMPTY" for require, exclude in rule_states):
        return "PROVEN_ENABLED_SERVICE_AUTH_POLICY_UNCONSTRAINED"
    if any("INVALID" in states for states in rule_states):
        return "NOT_PROVEN_SELECTED_SERVICE_TOKEN_POLICY_INVALID"
    return "NOT_PROVEN_SELECTED_SERVICE_TOKEN_POLICY_CONSTRAINED"


def unavailable_access_applicability(reason):
    return {
        "matching_application_count": 0,
        "matching_policy_count": 0,
        "non_identity_policy_count": 0,
        "service_token_selector_policy_count": 0,
        "service_token_match": reason,
        "service_token_policy_eligibility": "NOT_PROVEN_SERVICE_TOKEN_MATCH",
    }


def health_access_applicability(access_read_token, access_client_id, read):
    if not access_read_token:
        return unavailable_access_applicability("NOT_PROVEN_ACCESS_READ_CREDENTIAL_ABSENT")
    try:
        apps = access_pages(read, access_read_token, access_apps_url)
        candidates = [(score, app["id"]) for app in apps if (score := health_access_match_score(app)) is not None]
        if not candidates:
            return unavailable_access_applicability("NOT_PROVEN_SEPARATE_READ_SCOPE")
        best_score = max(score for score, _ in candidates)
        app_ids = sorted({app_id for score, app_id in candidates if score == best_score})
        require(1 <= len(app_ids) <= 20, "CF_RESPONSE_INVALID")
        policies = []
        for app_id in app_ids:
            policies.extend(access_pages(read, access_read_token,
                                         lambda page, app_id=app_id: access_app_policies_url(app_id, page)))
            require(len(policies) <= 200, "CF_RESPONSE_INVALID")
        require(all(isinstance(policy, dict) for policy in policies), "CF_RESPONSE_INVALID")
        match, enabled_selected_ids = service_token_match_detail(
            policies, access_client_id, access_read_token, read)
        return {
            "matching_application_count": len(app_ids),
            "matching_policy_count": len(policies),
            "non_identity_policy_count": sum(
                1 for policy in policies if policy.get("decision", policy.get("action")) in ("non_identity", "service_auth")
            ),
            "service_token_selector_policy_count": sum(1 for policy in policies if service_token_selector(policy)),
            # This fixed metadata read runs only after the one failed health GET.
            # IDs and client values stay private; the receipt carries an enum only.
            "service_token_match": match,
            "service_token_policy_eligibility": selected_service_token_policy_eligibility(
                policies, match, enabled_selected_ids),
        }
    except (PreflightError, urllib.error.HTTPError, urllib.error.URLError, TimeoutError,
            json.JSONDecodeError, UnicodeDecodeError, KeyError, TypeError, AttributeError, IndexError, OSError):
        return unavailable_access_applicability("NOT_PROVEN_ACCESS_READ_FAILED")


def worker_domains_url():
    host = urllib.parse.urlparse(ORIGIN).hostname
    require(isinstance(host, str) and host, "URL_NOT_ALLOWED")
    return CF + "/workers/domains?hostname=" + urllib.parse.quote(host, safe="")


def health_worker_domain_mapping(workers_read_token, read):
    if not workers_read_token:
        return "NOT_PROVEN_CUSTOM_DOMAIN_READ_CREDENTIAL_ABSENT"
    try:
        payload = read(worker_domains_url(), workers_read_token)
        domains = payload["result"]
        host = urllib.parse.urlparse(ORIGIN).hostname
        require(payload.get("success") is True and isinstance(host, str) and host, "CF_RESPONSE_INVALID")
        require(isinstance(domains, list) and len(domains) <= 1, "CF_RESPONSE_INVALID")
        if not domains:
            return "NOT_PROVEN_CUSTOM_DOMAIN_UNMAPPED"
        domain = domains[0]
        require(isinstance(domain, dict) and domain.get("hostname") == host, "CF_RESPONSE_INVALID")
        return ("PROVEN_CUSTOM_DOMAIN_SERVICE_MATCH" if domain.get("service") == WORKER
                else "NOT_PROVEN_CUSTOM_DOMAIN_SERVICE_MISMATCH")
    except (PreflightError, urllib.error.HTTPError, urllib.error.URLError, TimeoutError,
            json.JSONDecodeError, UnicodeDecodeError, KeyError, TypeError, AttributeError, IndexError, OSError):
        return "NOT_PROVEN_CUSTOM_DOMAIN_READ_FAILED"


def private_cf_ray_id(error):
    try:
        value = error.headers.get("CF-Ray")
    except (AttributeError, TypeError, ValueError):
        return None
    if not isinstance(value, str):
        return None
    match = re.fullmatch(r"([0-9A-Fa-f]{16})(?:-[A-Za-z0-9]{1,8})?", value)
    return match.group(1) if match else None


def graphql_access_login_payload(ray_id, request_time):
    require(isinstance(ray_id, str) and re.fullmatch(r"[0-9A-Fa-f]{16}", ray_id),
            "URL_NOT_ALLOWED")
    require(isinstance(request_time, datetime.datetime) and request_time.tzinfo is not None, "URL_NOT_ALLOWED")
    start = request_time - datetime.timedelta(minutes=5)
    end = datetime.datetime.now(datetime.timezone.utc)
    def iso(value):
        return value.astimezone(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return {
        "query": ACCESS_LOGIN_EVENT_QUERY,
        "variables": {"accountTag": ACCOUNT, "rayId": ray_id,
                      "datetimeStart": iso(start), "datetimeEnd": iso(end)},
    }


def graphql_error_result(errors):
    try:
        require(isinstance(errors, list) and 1 <= len(errors) <= 10, "CF_RESPONSE_INVALID")
        messages = []
        paths = []
        budget = False
        for error in errors:
            require(isinstance(error, dict) and isinstance(error.get("message"), str)
                    and len(error["message"]) <= 2_000, "CF_RESPONSE_INVALID")
            messages.append(error["message"].casefold())
            paths.append(error.get("path"))
            extensions = error.get("extensions")
            if extensions is not None:
                require(isinstance(extensions, dict), "CF_RESPONSE_INVALID")
                code = extensions.get("code")
                require(code is None or isinstance(code, str), "CF_RESPONSE_INVALID")
                budget = budget or code == "budget"
    except (PreflightError, KeyError, TypeError, AttributeError, IndexError):
        return "NOT_PROVEN_GRAPHQL_RESPONSE_ERROR"
    if budget:
        return "PROVEN_GRAPHQL_RATE_LIMIT"
    if all(message in ("unable to execute query, please try again later",
                       "too many queries in progress, please try again later") for message in messages):
        return "PROVEN_GRAPHQL_SERVICE_UNAVAILABLE"
    if all(message.startswith(("cannot request data older than", "number of fields can't be more than",
                               "limit must be positive number and not greater than",
                               "query time range is too large")) for message in messages):
        return "PROVEN_GRAPHQL_DATASET_LIMIT"
    if all(message.startswith(("error parsing args", "scalar fields must have no selections",
                               "object field must have selections", "unknown field",
                               "query contains error, please review it and retry")) for message in messages):
        return "PROVEN_GRAPHQL_QUERY_MALFORMED"
    if all(message == "not authorized for that account"
           or message.startswith("does not have access to the path")
           or (message.startswith("zones ") and message.endswith(" are not authorized"))
           for message in messages):
        return "PROVEN_GRAPHQL_ACCOUNT_NOT_AUTHORIZED"
    if all(isinstance(path, list) and path in (
            ["viewer", "accounts", 0, "accessLoginRequestsAdaptiveGroups"],
            ["viewer", "accounts", "0", "accessLoginRequestsAdaptiveGroups"],
    ) for path in paths):
        return "PROVEN_GRAPHQL_ACCESS_LOGIN_EVENT_PATH"
    if all(isinstance(path, list) for path in paths):
        return "PROVEN_GRAPHQL_ERROR_PATH_PRESENT_UNRECOGNIZED"
    if all("path" not in error for error in errors):
        return "PROVEN_GRAPHQL_ERROR_PATH_KEY_ABSENT"
    if all("path" in error and error["path"] is None for error in errors):
        return "PROVEN_GRAPHQL_ERROR_PATH_NULL"
    if all("path" in error and error["path"] is not None
           and not isinstance(error["path"], list) for error in errors):
        return "PROVEN_GRAPHQL_ERROR_PATH_PRESENT_INVALID_NON_NULL"
    return "NOT_PROVEN_GRAPHQL_ERROR_PATH_ABSENT_OR_INVALID"


def access_event_result(payload):
    if not isinstance(payload, dict) or "errors" not in payload:
        return "NOT_PROVEN_GRAPHQL_RESPONSE_ERROR"
    if payload.get("errors") is not None:
        return graphql_error_result(payload["errors"])
    try:
        accounts = payload["data"]["viewer"]["accounts"]
        require(isinstance(accounts, list) and len(accounts) == 1, "CF_RESPONSE_INVALID")
        events = accounts[0]["accessLoginRequestsAdaptiveGroups"]
        require(isinstance(events, list) and len(events) <= 1, "CF_RESPONSE_INVALID")
        if not events:
            return "NOT_PROVEN_ACCESS_EVENT_NOT_FOUND"
        dimensions = events[0]["dimensions"]
        require(isinstance(dimensions, dict) and set(dimensions) ==
                {"isSuccessfulLogin", "identityProvider", "serviceTokenId"}, "CF_RESPONSE_INVALID")
        success = dimensions["isSuccessfulLogin"]
        identity_provider = dimensions["identityProvider"]
        service_token_id = dimensions["serviceTokenId"]
        require(type(success) is int and success in (0, 1)
                and isinstance(identity_provider, str) and isinstance(service_token_id, str), "CF_RESPONSE_INVALID")
        if success == 1 and identity_provider == "nonidentity" and service_token_id:
            return "PROVEN_ACCESS_SERVICE_TOKEN_AUTHORIZED"
        if success == 1 and identity_provider == "nonidentity":
            return "PROVEN_ACCESS_AUTHORIZED_NONIDENTITY_WITHOUT_SERVICE_TOKEN"
        if success == 1:
            return "PROVEN_ACCESS_AUTHORIZED_NON_SERVICE_TOKEN"
        return ("PROVEN_ACCESS_NONIDENTITY_DENIED" if identity_provider == "nonidentity"
                else "PROVEN_ACCESS_DENIED_NON_SERVICE_TOKEN")
    except (PreflightError, KeyError, TypeError, AttributeError, IndexError):
        return "NOT_PROVEN_GRAPHQL_RESPONSE_INVALID"


def health_access_event(access_read_token, error, request_time, read):
    if not access_read_token:
        return "NOT_PROVEN_ANALYTICS_READ_CREDENTIAL_ABSENT"
    ray_id = private_cf_ray_id(error)
    if ray_id is None:
        return "NOT_PROVEN_CF_RAY_HEADER_ABSENT_OR_INVALID"
    try:
        payload = read(GRAPHQL, access_read_token,
                       graphql=graphql_access_login_payload(ray_id, request_time))
        return access_event_result(payload)
    except urllib.error.HTTPError as graphql_error:
        if graphql_error.code == 403:
            return "PROVEN_ACCOUNT_ANALYTICS_READ_MISSING"
        return ("NOT_PROVEN_ANALYTICS_TOKEN_INVALID" if graphql_error.code == 401
                else "NOT_PROVEN_GRAPHQL_ACCESS_EVENT_READ_FAILED")
    except (PreflightError, urllib.error.URLError, TimeoutError, json.JSONDecodeError,
            UnicodeDecodeError, KeyError, TypeError, AttributeError, IndexError, OSError):
        return "NOT_PROVEN_GRAPHQL_ACCESS_EVENT_READ_FAILED"


def health_403_response_class(error):
    try:
        raw = error.read(HEALTH_DIAGNOSTIC_MAX_BYTES + 1)
    except (OSError, ValueError, AttributeError):
        return "BODY_UNAVAILABLE"
    if not isinstance(raw, bytes) or len(raw) > HEALTH_DIAGNOSTIC_MAX_BYTES:
        return "BODY_TOO_LARGE"
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return "NON_JSON"
    if not isinstance(payload, dict) or payload.get("error") != "ACCESS_AUTHENTICATION_FAILED":
        return "JSON_NOT_WORKER_ACCESS_AUTH_SCHEMA"
    diagnostic = payload.get("diagnostic")
    candidate = "WORKER_" + diagnostic if isinstance(diagnostic, str) else "WORKER_ACCESS_AUTHENTICATION_FAILED"
    return (candidate if candidate in HEALTH_ACCESS_RESPONSE_CLASSES else
            "WORKER_ACCESS_AUTHENTICATION_FAILED_UNRECOGNIZED_DIAGNOSTIC")


def health_403_diagnostic(error, env, read, request_time):
    response_class = health_403_response_class(error)
    return {
        "response_class": response_class if response_class in HEALTH_ACCESS_RESPONSE_CLASSES else "BODY_UNAVAILABLE",
        "credential_presence": {
            "access_client_id": bool(env.get("CONTROL_ACCESS_CLIENT_ID")),
            "access_client_secret": bool(env.get("CONTROL_ACCESS_CLIENT_SECRET")),
            "access_read_token": bool(env.get("CLOUDFLARE_ACCESS_READ_TOKEN")),
        },
        "access_applicability": health_access_applicability(
            env.get("CLOUDFLARE_ACCESS_READ_TOKEN", ""), env.get("CONTROL_ACCESS_CLIENT_ID", ""), read),
        "worker_domain_mapping": health_worker_domain_mapping(
            env.get("CLOUDFLARE_WORKERS_READ_TOKEN", ""), read),
        "access_event": health_access_event(
            env.get("CLOUDFLARE_ACCESS_READ_TOKEN", ""), error, request_time, read),
    }


def public_health_403_diagnostic(value):
    if not isinstance(value, dict) or value.get("response_class") not in HEALTH_ACCESS_RESPONSE_CLASSES:
        return None
    presence = value.get("credential_presence")
    applicability = value.get("access_applicability")
    domain_mapping = value.get("worker_domain_mapping")
    access_event = value.get("access_event")
    if (not isinstance(presence, dict) or not isinstance(applicability, dict)
            or domain_mapping not in WORKER_DOMAIN_DIAGNOSTICS
            or access_event not in ACCESS_EVENT_DIAGNOSTICS):
        return None
    if set(presence) != {"access_client_id", "access_client_secret", "access_read_token"} or not all(
            type(presence[name]) is bool for name in presence):
        return None
    required = {"matching_application_count", "matching_policy_count", "non_identity_policy_count",
                "service_token_selector_policy_count", "service_token_match", "service_token_policy_eligibility"}
    if (set(applicability) != required or
            applicability.get("service_token_match") not in ACCESS_POLICY_DIAGNOSTICS or
            applicability.get("service_token_policy_eligibility") not in SERVICE_TOKEN_POLICY_ELIGIBILITY):
        return None
    counts = [applicability[name] for name in required
              if name not in ("service_token_match", "service_token_policy_eligibility")]
    if not all(type(count) is int and 0 <= count <= 200 for count in counts):
        return None
    return {"response_class": value["response_class"], "credential_presence": presence,
            "access_applicability": applicability, "worker_domain_mapping": domain_mapping,
            "access_event": access_event}


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
        health_request_time = datetime.datetime.now(datetime.timezone.utc)
        try:
            observed = read(ORIGIN + "/api/health", None, access=access)
        except urllib.error.HTTPError as error:
            if error.code == 403:
                # This is a single, fixed-target diagnostic sequence, not a
                # health retry. It publishes only allowlisted classifications.
                diagnostic["health_403"] = health_403_diagnostic(
                    error, env, read, health_request_time)
            raise
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
    receipt = {"preflight": "STOP", "reason": "READONLY_EVIDENCE_FAILED_CLOSED",
               "stage": stage if type(stage) is str and stage in STAGES else "UNKNOWN",
               "code": code, "http_status": status,
               "production_mutations": 0, "activation_ready": False}
    health_403 = public_health_403_diagnostic(diagnostic.get("health_403"))
    if receipt["stage"] == "WORKER_HEALTH" and code == "HTTP_ERROR" and status == 403 and health_403:
        receipt["health_403"] = health_403
    return receipt


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
