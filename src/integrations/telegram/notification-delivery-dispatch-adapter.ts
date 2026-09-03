import type {
  NotificationDeliveryDispatchAdapter,
  NotificationDeliveryDispatchAttempt,
} from "../../shared/notification-delivery-dispatch-attempt.js";
import type { NotificationDeliveryResult } from "../../shared/notification-delivery.js";

export const TELEGRAM_BOT_API_ORIGIN = "https://api.telegram.org" as const;
export const TELEGRAM_SEND_MESSAGE_TEXT_LIMIT = 4096;
export const TELEGRAM_RESPONSE_MAX_CHARACTERS = 16_384;

const TARGET_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const BOT_TOKEN_PATTERN = /^[A-Za-z0-9:_-]{1,256}$/;

export interface TelegramNotificationDeliveryConfig {
  readonly targetKey: string;
  readonly botToken: string;
  readonly chatId: string | number;
  readonly controlOrigin: string;
}

export type TelegramNotificationFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export type TelegramNotificationDeliveryAdapterErrorCode =
  | "INVALID_CONFIGURATION"
  | "AMBIGUOUS_PROVIDER_OUTCOME";

const errorMessages: Readonly<
  Record<TelegramNotificationDeliveryAdapterErrorCode, string>
> = {
  INVALID_CONFIGURATION: "Telegram notification adapter configuration failed validation",
  AMBIGUOUS_PROVIDER_OUTCOME: "Telegram notification provider outcome was ambiguous",
};

export class TelegramNotificationDeliveryAdapterError extends Error {
  readonly code: TelegramNotificationDeliveryAdapterErrorCode;

  constructor(code: TelegramNotificationDeliveryAdapterErrorCode) {
    super(errorMessages[code]);
    this.name = "TelegramNotificationDeliveryAdapterError";
    this.code = code;
  }
}

interface NormalizedTelegramConfig {
  readonly targetKey: string;
  readonly endpoint: string;
  readonly chatId: string | number;
  readonly controlOrigin: string;
}

function invalidConfiguration(): never {
  throw new TelegramNotificationDeliveryAdapterError("INVALID_CONFIGURATION");
}

function ambiguousProviderOutcome(): never {
  throw new TelegramNotificationDeliveryAdapterError("AMBIGUOUS_PROVIDER_OUTCOME");
}

function normalizeTargetKey(value: string): string {
  if (!TARGET_KEY_PATTERN.test(value)) invalidConfiguration();
  return value;
}

function telegramEndpoint(botToken: string): string {
  if (!BOT_TOKEN_PATTERN.test(botToken)) invalidConfiguration();
  return `${TELEGRAM_BOT_API_ORIGIN}/bot${botToken}/sendMessage`;
}

function normalizeChatId(value: string | number): string | number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value === 0) invalidConfiguration();
    return value;
  }

  if (
    value.length < 1 ||
    value.length > 256 ||
    value.trim() !== value ||
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
    })
  ) {
    invalidConfiguration();
  }
  return value;
}

function normalizeControlOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalidConfiguration();
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    invalidConfiguration();
  }
  return parsed.origin;
}

function normalizeConfig(
  config: TelegramNotificationDeliveryConfig,
): NormalizedTelegramConfig {
  return {
    targetKey: normalizeTargetKey(config.targetKey),
    endpoint: telegramEndpoint(config.botToken),
    chatId: normalizeChatId(config.chatId),
    controlOrigin: normalizeControlOrigin(config.controlOrigin),
  };
}

function renderMessage(
  attempt: NotificationDeliveryDispatchAttempt,
  controlOrigin: string,
): string | null {
  const { envelope } = attempt;
  const deepLink = `${controlOrigin}${envelope.deepLinkPath}`;
  const text = [
    envelope.title,
    envelope.reference,
    "",
    envelope.body,
    "",
    deepLink,
  ].join("\n");
  const characterCount = Array.from(text).length;
  if (characterCount < 1 || characterCount > TELEGRAM_SEND_MESSAGE_TEXT_LIMIT) {
    return null;
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSuccessfulSendMessageResult(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Number.isSafeInteger(value.message_id) && Number(value.message_id) > 0;
}

function explicitFailureResult(
  code: number,
): NotificationDeliveryResult | null {
  if (code === 429) {
    return { kind: "RETRYABLE_FAILURE", reason: "RATE_LIMITED" };
  }
  if (code === 408 || code === 425) {
    return { kind: "RETRYABLE_FAILURE", reason: "TRANSIENT_UPSTREAM" };
  }
  if (code >= 500 && code <= 599) {
    return { kind: "RETRYABLE_FAILURE", reason: "PROVIDER_UNAVAILABLE" };
  }
  if (code === 401 || code === 403 || code === 404) {
    return { kind: "TERMINAL_FAILURE", reason: "AUTHORIZATION_FAILED" };
  }
  if (code >= 400 && code <= 499) {
    return { kind: "TERMINAL_FAILURE", reason: "PAYLOAD_REJECTED" };
  }
  return null;
}

async function parseSuccessfulHttpResponse(
  response: Response,
): Promise<NotificationDeliveryResult> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return ambiguousProviderOutcome();
  }

  if (text.length < 1 || text.length > TELEGRAM_RESPONSE_MAX_CHARACTERS) {
    return ambiguousProviderOutcome();
  }

  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return ambiguousProviderOutcome();
  }

  if (!isRecord(body) || typeof body.ok !== "boolean") {
    return ambiguousProviderOutcome();
  }

  if (body.ok) {
    if (!isSuccessfulSendMessageResult(body.result)) {
      return ambiguousProviderOutcome();
    }
    return { kind: "DELIVERED" };
  }

  if (!Number.isSafeInteger(body.error_code)) {
    return ambiguousProviderOutcome();
  }
  const failure = explicitFailureResult(Number(body.error_code));
  if (failure === null) return ambiguousProviderOutcome();
  return failure;
}

async function classifyTelegramResponse(
  response: Response,
): Promise<NotificationDeliveryResult> {
  const explicitFailure = explicitFailureResult(response.status);
  if (explicitFailure !== null) return explicitFailure;

  if (response.status < 200 || response.status >= 300) {
    return ambiguousProviderOutcome();
  }

  return parseSuccessfulHttpResponse(response);
}

/**
 * Create a source-only Telegram `sendMessage` delivery adapter.
 *
 * The bot token and chat destination remain closure-local runtime inputs. The
 * adapter does not log or persist them, and provider descriptions are ignored.
 * Network exceptions and malformed/ambiguous provider responses throw only a
 * sanitized error so the durable dispatch executor can preserve its claim and
 * classify the outcome as ambiguous.
 */
export function createTelegramNotificationDeliveryDispatchAdapter(
  config: TelegramNotificationDeliveryConfig,
  fetcher: TelegramNotificationFetch = fetch,
): NotificationDeliveryDispatchAdapter {
  const normalized = normalizeConfig(config);

  return {
    async deliver(
      attempt: NotificationDeliveryDispatchAttempt,
    ): Promise<NotificationDeliveryResult> {
      if (attempt.envelope.targetKey !== normalized.targetKey) {
        return { kind: "TERMINAL_FAILURE", reason: "DESTINATION_INVALID" };
      }

      const text = renderMessage(attempt, normalized.controlOrigin);
      if (text === null) {
        return { kind: "TERMINAL_FAILURE", reason: "PAYLOAD_REJECTED" };
      }

      let response: Response;
      try {
        response = await fetcher(normalized.endpoint, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            chat_id: normalized.chatId,
            text,
          }),
          redirect: "manual",
        });
      } catch {
        return ambiguousProviderOutcome();
      }

      return classifyTelegramResponse(response);
    },
  };
}
