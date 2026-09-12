import { readFileSync, statSync } from "node:fs";

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_RECORDS = 64;
const MAX_SIGNAL_CHARS = 8192;
const SIGNAL_KEYS = new Set(["type", "code", "name", "message", "kind", "status", "category"]);
const SENSITIVE_KEYS = /(?:^|[_-])(?:token|secret|authorization|credential|password|private|config|vars|value|text|content|body|header|request|response)(?:$|[_-])/i;

function unavailable(reason) {
  return {
    diagnostic: "UNAVAILABLE",
    reason,
    classification: "UNKNOWN",
    detail: "SANITIZED_STRUCTURED_OUTPUT_UNAVAILABLE",
    raw_fields_emitted: false,
  };
}

function collectSignals(value, signals, depth = 0) {
  if (depth > 6 || signals.join(" ").length >= MAX_SIGNAL_CHARS) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, MAX_RECORDS)) collectSignals(item, signals, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEYS.test(key)) continue;
    const normalizedKey = key.toLowerCase();
    if (SIGNAL_KEYS.has(normalizedKey) && (typeof child === "string" || typeof child === "number")) {
      signals.push(`${normalizedKey}:${String(child).slice(0, 2048)}`);
      if (signals.join(" ").length >= MAX_SIGNAL_CHARS) return;
    }
    if (child && typeof child === "object") collectSignals(child, signals, depth + 1);
  }
}

function classify(signals) {
  const text = signals.join(" ").toLowerCase();
  if (/strict(?:\s|-|_)*(?:mode|validation|conflict|error|violation)|(?:conflict|violation).*strict/.test(text)) {
    return "STRICT_CONFLICT";
  }
  if (/unauthori[sz]ed|authentication|invalid\s+(?:api\s+)?token|token\s+(?:is\s+)?invalid|credential(?:s)?\s+(?:are\s+)?invalid/.test(text)) {
    return "AUTH";
  }
  if (/forbidden|permission\s+denied|insufficient\s+(?:permission|scope)|not\s+(?:authorized|permitted)|access\s+denied/.test(text)) {
    return "PERMISSION";
  }
  if (/configuration|\bconfig\b|binding|resource\s+validation|invalid\s+(?:field|option|binding|configuration)|unknown\s+(?:argument|option)/.test(text)) {
    return "CONFIG";
  }
  return "UNKNOWN";
}

export function parseWranglerFailureDiagnostics(raw) {
  if (typeof raw !== "string" || raw.length === 0) return unavailable("OUTPUT_EMPTY");

  const records = [];
  let malformed = false;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (records.length >= MAX_RECORDS) break;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === "object") records.push(record);
      else malformed = true;
    } catch {
      malformed = true;
    }
  }

  if (records.length === 0) return unavailable(malformed ? "OUTPUT_MALFORMED" : "OUTPUT_EMPTY");

  const signals = [];
  for (const record of records) collectSignals(record, signals);
  const classification = classify(signals);
  return {
    diagnostic: "AVAILABLE",
    reason: malformed ? "PARTIAL_MALFORMED_LINES_SUPPRESSED" : "STRUCTURED_OUTPUT_PARSED",
    classification,
    detail: classification === "UNKNOWN"
      ? "STRUCTURED_ERROR_PRESENT_RAW_DETAIL_SUPPRESSED"
      : `${classification}_SIGNAL_PRESENT_RAW_DETAIL_SUPPRESSED`,
    raw_fields_emitted: false,
  };
}

export function readWranglerFailureDiagnostics(outputPath) {
  try {
    const stat = statSync(outputPath);
    if (!stat.isFile()) return unavailable("OUTPUT_NOT_FILE");
    if (stat.size > MAX_OUTPUT_BYTES) return unavailable("OUTPUT_TOO_LARGE");
    return parseWranglerFailureDiagnostics(readFileSync(outputPath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return unavailable("OUTPUT_MISSING");
    }
    return unavailable("OUTPUT_UNREADABLE");
  }
}

export function emitWranglerFailureDiagnostics(outputPath, write = (line) => console.error(line)) {
  const result = readWranglerFailureDiagnostics(outputPath);
  write(`WRANGLER_FAILURE_DIAGNOSTIC=${result.diagnostic}`);
  write(`WRANGLER_FAILURE_REASON=${result.reason}`);
  write(`WRANGLER_FAILURE_CLASS=${result.classification}`);
  write(`WRANGLER_FAILURE_DETAIL=${result.detail}`);
  write(`WRANGLER_FAILURE_RAW_FIELDS_EMITTED=${result.raw_fields_emitted ? "YES" : "NO"}`);
}
