const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AUDIENCE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const HOST_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

export class AccessAppIdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AccessAppIdentityError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new AccessAppIdentityError(code, message);
}

function normalizePublicUri(value) {
  if (typeof value !== "string") return "";
  let normalized = value.trim();
  normalized = normalized.replace(/^https?:\/\//i, "");
  while (normalized.endsWith("/") && normalized !== "/") normalized = normalized.slice(0, -1);

  const wholeSiteWildcard = normalized.match(/^([^/]+)\/\*$/);
  if (wholeSiteWildcard) normalized = wholeSiteWildcard[1];

  return normalized;
}

function isPublicDestination(destination) {
  if (!destination || typeof destination !== "object") return false;
  if (destination.type !== undefined && destination.type !== "public") return false;
  return typeof destination.uri === "string";
}

function validHostnameLabels(value) {
  const labels = value.split(".");
  return labels.length >= 2 && labels.every((label) => HOST_LABEL_PATTERN.test(label));
}

export function readAccessTokenApplicationAudience(token) {
  if (typeof token !== "string" || token.length === 0) {
    fail("ACCESS_TOKEN_INVALID", "Access token is missing");
  }

  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    fail("ACCESS_TOKEN_INVALID", "Access token is not a compact JWT");
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    fail("ACCESS_TOKEN_PAYLOAD_INVALID", "Access token payload could not be decoded");
  }

  if (payload?.type !== "app") {
    fail("ACCESS_TOKEN_TYPE_INVALID", "Access token must be an application token");
  }

  const audiences = payload?.aud;
  if (
    !Array.isArray(audiences) ||
    audiences.length !== 1 ||
    typeof audiences[0] !== "string" ||
    !AUDIENCE_PATTERN.test(audiences[0])
  ) {
    fail("ACCESS_TOKEN_AUDIENCE_INVALID", "Access token must contain exactly one bounded application audience");
  }

  return audiences[0];
}

export function accessApplicationPublicUris(app) {
  const destinations = app?.destinations;
  if (Array.isArray(destinations) && destinations.length > 0) {
    return destinations
      .filter(isPublicDestination)
      .map((destination) => normalizePublicUri(destination?.uri))
      .filter(Boolean);
  }

  const legacyDomain = normalizePublicUri(app?.domain);
  return legacyDomain ? [legacyDomain] : [];
}

export function accessApplicationProtectsHost(app, expectedHost) {
  const normalizedExpected = normalizePublicUri(expectedHost);
  if (
    !normalizedExpected ||
    normalizedExpected.includes("/") ||
    normalizedExpected.includes("*") ||
    !validHostnameLabels(normalizedExpected)
  ) {
    return false;
  }

  const expected = normalizedExpected.toLowerCase();
  const expectedLabels = expected.split(".");

  return accessApplicationPublicUris(app).some((uri) => {
    if (uri.includes("/")) return false;

    const candidate = uri.toLowerCase();
    if (candidate === expected) return true;
    if (!candidate.startsWith("*.")) return false;

    const suffix = candidate.slice(2);
    if (!suffix || suffix.includes("*") || !validHostnameLabels(suffix)) return false;

    const suffixLabels = suffix.split(".");
    return expectedLabels.length === suffixLabels.length + 1 && expectedLabels.slice(1).join(".") === suffix;
  });
}

export function exactParentAccessApplication(apps, audience, expectedId = "") {
  if (!Array.isArray(apps)) fail("ACCESS_APP_INVENTORY_INVALID", "Access application inventory is not an array");
  if (!AUDIENCE_PATTERN.test(audience)) fail("ACCESS_AUDIENCE_INVALID", "Access application audience is invalid");

  const matches = apps.filter(
    (app) =>
      app?.type === "self_hosted" &&
      app?.aud === audience &&
      (expectedId === "" || app?.id === expectedId),
  );

  if (matches.length !== 1) {
    fail("ACCESS_PARENT_APP_AMBIGUOUS", "Access token audience did not identify exactly one parent self-hosted application");
  }

  const app = matches[0];
  if (typeof app?.id !== "string" || !UUID_PATTERN.test(app.id)) {
    fail("ACCESS_PARENT_APP_ID_INVALID", "parent Access application id is invalid");
  }
  return app;
}

export function exactWebhookAccessApplications(apps, expectedUri, expectedName) {
  if (!Array.isArray(apps)) fail("ACCESS_APP_INVENTORY_INVALID", "Access application inventory is not an array");
  const normalizedExpectedUri = normalizePublicUri(expectedUri);
  if (!normalizedExpectedUri) fail("ACCESS_WEBHOOK_URI_INVALID", "expected webhook Access URI is invalid");

  return apps.filter((app) => {
    if (app?.type !== "self_hosted") return false;
    const exactTarget = accessApplicationPublicUris(app).includes(normalizedExpectedUri);
    const reservedName = typeof expectedName === "string" && expectedName.length > 0 && app?.name === expectedName;
    return exactTarget || reservedName;
  });
}

export function assertExactWebhookAccessApplication(app, expectedId, expectedUri, expectedName) {
  if (app?.id !== expectedId || !UUID_PATTERN.test(expectedId)) {
    fail("ACCESS_WEBHOOK_APP_ID_INVALID", "webhook Access application id is invalid or changed");
  }
  if (app?.type !== "self_hosted" || app?.name !== expectedName || app?.app_launcher_visible !== false) {
    fail("ACCESS_WEBHOOK_APP_SHAPE_INVALID", "webhook Access application shape changed");
  }
  const normalizedExpectedUri = normalizePublicUri(expectedUri);
  if (!accessApplicationPublicUris(app).includes(normalizedExpectedUri)) {
    fail("ACCESS_WEBHOOK_APP_DESTINATION_INVALID", "webhook Access application does not contain the exact reviewed public destination");
  }
  return app;
}
