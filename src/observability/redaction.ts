import {
  JSON_SCHEMA,
  YAMLException,
  loadAll,
  type EventType,
  type LoadOptions,
} from "js-yaml";
import { canonicalJson } from "../shared/json";

export const SERVING_REDACTION_VERSION = "serving-redaction/v1" as const;
export const SERVING_REDACTION_HARD_MAX_INPUT_BYTES = 256 * 1024;
export const SERVING_REDACTION_HARD_MAX_TEXT_BYTES = 16 * 1024;

const REDACTED_VALUE = "[REDACTED]";
const MAX_STRUCTURED_DEPTH = 32;
const MAX_STRUCTURED_NODES = 4096;
const MAX_STRUCTURED_DOCUMENTS = 8;
const MAX_YAML_ANCHORS = 32;
const MAX_YAML_ALIASES = 32;

export const SERVING_REDACTION_LABELS = [
  "k8s_secret",
  "bearer_token",
  "jwt",
  "private_key",
  "credential_assignment",
  "url_credential",
  "truncated",
] as const;

export type ServingRedactionLabel = (typeof SERVING_REDACTION_LABELS)[number];

export type RedactedServingQuestion =
  | {
      disposition: "redacted";
      text: string;
      redactionVersion: typeof SERVING_REDACTION_VERSION;
      redactionLabels: ServingRedactionLabel[];
    }
  | {
      disposition: "dropped_sensitive" | "dropped_invalid";
      redactionVersion: typeof SERVING_REDACTION_VERSION;
      redactionLabels: ServingRedactionLabel[];
    };

export interface ServingQuestionRedactionOptions {
  maxInputBytes: number;
  maxTextBytes: number;
}

export type ServingRedactionErrorCode =
  | "invalid_options"
  | "verification_failed"
  | "redaction_internal";

export class ServingRedactionError extends Error {
  constructor(readonly code: ServingRedactionErrorCode) {
    super(`serving redaction failed: ${code}`);
    this.name = "ServingRedactionError";
  }
}

class UnsafeStructuredInputError extends Error {}

const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/giu;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu;
const JWT_PATTERN =
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const AUTHORIZATION_PATTERN = /\bAuthorization\s*[:=]\s*[^\r\n]+/giu;
const CREDENTIAL_ASSIGNMENT_PATTERN =
  /(["']?)\b((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?access[_-]?key|secret[_-]?key|access[_-]?key(?:[_-]?id)?|password|passwd|pwd|token|credential|cookie|secret|auth))\b\1(\s*(?:=|:(?!:))\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,;]+)/giu;
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/giu;
const AWS_ACCESS_KEY_PATTERN = /\bAKIA[A-Z0-9]{16}\b/gu;
const GITHUB_TOKEN_PATTERN = /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu;

const SENSITIVE_QUERY_KEYS = new Set([
  "access_token",
  "apikey",
  "api_key",
  "auth",
  "authorization",
  "credential",
  "key",
  "password",
  "passwd",
  "secret",
  "sig",
  "signature",
  "token",
  "x-amz-credential",
  "x-amz-signature",
  "x-goog-signature",
]);

const SENSITIVE_KEY_NAMES = new Set([
  "accesskey",
  "accesskeyid",
  "accesstoken",
  "apikey",
  "auth",
  "authorization",
  "clientsecret",
  "cookie",
  "credential",
  "credentials",
  "password",
  "passwd",
  "privatekey",
  "pwd",
  "refreshtoken",
  "secretkey",
  "secretaccesskey",
  "secret",
  "token",
]);

const SENSITIVE_KEY_SUFFIXES = [...SENSITIVE_KEY_NAMES].filter(
  (key) => key !== "authorization",
);

function orderedLabels(
  labels: ReadonlySet<ServingRedactionLabel>,
): ServingRedactionLabel[] {
  return SERVING_REDACTION_LABELS.filter((label) => labels.has(label));
}

function dropped(
  disposition: "dropped_sensitive" | "dropped_invalid",
  labels: ReadonlySet<ServingRedactionLabel> = new Set(),
): RedactedServingQuestion {
  return {
    disposition,
    redactionVersion: SERVING_REDACTION_VERSION,
    redactionLabels: orderedLabels(labels),
  };
}

function normalizedKey(key: string): string {
  return key.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/gu, "");
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return (
    SENSITIVE_KEY_NAMES.has(normalized) ||
    SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

function isRedactedValue(value: string | null): boolean {
  return value === REDACTED_VALUE || value === "%5BREDACTED%5D";
}

function urlsIn(text: string): string[] {
  return [...text.matchAll(new RegExp(URL_PATTERN.source, URL_PATTERN.flags))]
    .map((match) => match[0])
    .filter((value): value is string => value !== undefined);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isJwtCandidate(candidate: string): boolean {
  const [headerSegment, payloadSegment, signatureSegment, extra] =
    candidate.split(".");
  if (
    headerSegment === undefined ||
    payloadSegment === undefined ||
    signatureSegment === undefined ||
    extra !== undefined
  ) {
    return false;
  }

  try {
    const header = JSON.parse(
      Buffer.from(headerSegment, "base64url").toString("utf8"),
    ) as unknown;
    const payload = JSON.parse(
      Buffer.from(payloadSegment, "base64url").toString("utf8"),
    ) as unknown;
    return (
      isPlainRecord(header) &&
      typeof header.alg === "string" &&
      header.alg.length > 0 &&
      isPlainRecord(payload)
    );
  } catch {
    return false;
  }
}

function containsJwt(text: string): boolean {
  const pattern = new RegExp(JWT_PATTERN.source, JWT_PATTERN.flags);
  return [...text.matchAll(pattern)].some((match) => isJwtCandidate(match[0]));
}

function urlContainsCredential(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return true;
    for (const [key, value] of url.searchParams) {
      if (
        SENSITIVE_QUERY_KEYS.has(key.toLocaleLowerCase("en-US")) &&
        !isRedactedValue(value)
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return /@|(?:token|secret|password|key)=/iu.test(raw);
  }
}

function detectSensitiveLabels(text: string): Set<ServingRedactionLabel> {
  const labels = new Set<ServingRedactionLabel>();
  if (/\bkind\s*:\s*Secret\b/iu.test(text)) labels.add("k8s_secret");
  if (new RegExp(BEARER_PATTERN.source, BEARER_PATTERN.flags).test(text)) {
    labels.add("bearer_token");
  }
  if (containsJwt(text)) {
    labels.add("jwt");
  }
  if (
    new RegExp(PRIVATE_KEY_PATTERN.source, PRIVATE_KEY_PATTERN.flags).test(text)
  ) {
    labels.add("private_key");
  }
  if (
    new RegExp(
      CREDENTIAL_ASSIGNMENT_PATTERN.source,
      CREDENTIAL_ASSIGNMENT_PATTERN.flags,
    ).test(text)
  ) {
    labels.add("credential_assignment");
  }
  if (urlsIn(text).some(urlContainsCredential)) labels.add("url_credential");
  return labels;
}

function redactUrls(text: string, labels: Set<ServingRedactionLabel>): string {
  return text.replace(URL_PATTERN, (raw) => {
    try {
      const url = new URL(raw);
      let changed = false;
      if (url.username || url.password) {
        url.username = "";
        url.password = "";
        changed = true;
      }
      for (const key of [...url.searchParams.keys()]) {
        if (SENSITIVE_QUERY_KEYS.has(key.toLocaleLowerCase("en-US"))) {
          url.searchParams.set(key, REDACTED_VALUE);
          changed = true;
        }
      }
      if (!changed) return raw;
      labels.add("url_credential");
      return url.toString();
    } catch {
      return raw;
    }
  });
}

function redactText(text: string, labels: Set<ServingRedactionLabel>): string {
  for (const label of detectSensitiveLabels(text)) labels.add(label);

  let redacted = redactUrls(text, labels);
  redacted = redacted.replace(PRIVATE_KEY_PATTERN, REDACTED_VALUE);
  redacted = redacted.replace(
    AUTHORIZATION_PATTERN,
    "Authorization: [REDACTED]",
  );
  redacted = redacted.replace(BEARER_PATTERN, "Bearer [REDACTED]");
  redacted = redacted.replace(JWT_PATTERN, (candidate) =>
    isJwtCandidate(candidate) ? REDACTED_VALUE : candidate,
  );
  redacted = redacted.replace(
    CREDENTIAL_ASSIGNMENT_PATTERN,
    (_match, quote: string, key: string, separator: string) =>
      `${quote}${key}${quote}${separator}${REDACTED_VALUE}`,
  );
  return redacted;
}

function looksStructured(input: string): boolean {
  const trimmed = input.trimStart();
  if (
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("---")
  ) {
    return true;
  }
  if (
    /^\s*(?:apiVersion|kind|metadata|data|stringData|items)\s*:/imu.test(input)
  ) {
    return true;
  }
  const mappingLines = input.match(
    /^\s*(?:-\s*)?[A-Za-z_][A-Za-z0-9_.-]*\s*:(?!\/\/)/gmu,
  );
  return (mappingLines?.length ?? 0) >= 2;
}

function countYamlReferenceTokens(input: string, marker: "*" | "&"): number {
  const escaped = marker === "*" ? "\\*" : "&";
  const pattern = new RegExp(
    `(?:^|[\\s\\[\\]{},])${escaped}(?=[^\\s\\[\\]{},]+(?:$|[\\s\\[\\]{},]))`,
    "gmu",
  );
  return input.match(pattern)?.length ?? 0;
}

function assertYamlReferenceBounds(input: string): void {
  if (
    countYamlReferenceTokens(input, "&") > MAX_YAML_ANCHORS ||
    countYamlReferenceTokens(input, "*") > MAX_YAML_ALIASES
  ) {
    throw new UnsafeStructuredInputError();
  }
}

interface BoundedLoadOptions extends LoadOptions {
  maxDepth: number;
  maxMergeSeqLength: number;
}

function parseStructured(input: string): unknown {
  assertYamlReferenceBounds(input);
  let parserNodes = 0;
  const options: BoundedLoadOptions = {
    schema: JSON_SCHEMA,
    maxDepth: MAX_STRUCTURED_DEPTH,
    maxMergeSeqLength: 16,
    listener(eventType: EventType) {
      if (eventType === "open" && ++parserNodes > MAX_STRUCTURED_NODES) {
        throw new UnsafeStructuredInputError();
      }
    },
  };
  const documents = loadAll(input, null, options);
  if (
    documents.length === 0 ||
    documents.length > MAX_STRUCTURED_DOCUMENTS ||
    documents.some((document) => document === undefined)
  ) {
    throw new UnsafeStructuredInputError();
  }
  return documents.length === 1 ? documents[0] : documents;
}

interface TraversalState {
  active: WeakSet<object>;
  labels: Set<ServingRedactionLabel>;
  nodes: number;
}

function redactStructuredValue(
  value: unknown,
  depth: number,
  state: TraversalState,
): unknown {
  if (depth > MAX_STRUCTURED_DEPTH || ++state.nodes > MAX_STRUCTURED_NODES) {
    throw new UnsafeStructuredInputError();
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new UnsafeStructuredInputError();
    return value;
  }
  if (typeof value === "string") return redactText(value, state.labels);
  if (typeof value !== "object") throw new UnsafeStructuredInputError();
  if (state.active.has(value)) throw new UnsafeStructuredInputError();

  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactStructuredValue(item, depth + 1, state));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new UnsafeStructuredInputError();
    }

    const source = value as Record<string, unknown>;
    const isSecret =
      typeof source.kind === "string" &&
      source.kind.toLocaleLowerCase("en-US") === "secret";
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(source)) {
      const normalized = normalizedKey(key);
      if (isSecret && (normalized === "data" || normalized === "stringdata")) {
        state.labels.add("k8s_secret");
        output[key] = REDACTED_VALUE;
      } else if (isSensitiveKey(key)) {
        state.labels.add("credential_assignment");
        output[key] = REDACTED_VALUE;
      } else {
        output[key] = redactStructuredValue(source[key], depth + 1, state);
      }
    }
    return output;
  } finally {
    state.active.delete(value);
  }
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let bytes = 0;
  let output = "";
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    output += character;
    bytes += characterBytes;
  }
  return output;
}

function credentialAssignmentRemains(text: string): boolean {
  const pattern = new RegExp(
    CREDENTIAL_ASSIGNMENT_PATTERN.source,
    CREDENTIAL_ASSIGNMENT_PATTERN.flags,
  );
  for (const match of text.matchAll(pattern)) {
    const rawValue = match[4]?.trim();
    if (rawValue === undefined) return true;
    const first = rawValue[0];
    const value =
      rawValue.length >= 2 &&
      (first === '"' || first === "'") &&
      rawValue.at(-1) === first
        ? rawValue.slice(1, -1)
        : rawValue;
    if (!isRedactedValue(value)) {
      return true;
    }
  }
  return false;
}

export function containsSensitiveServingText(text: string): boolean {
  if (
    new RegExp(PRIVATE_KEY_PATTERN.source, PRIVATE_KEY_PATTERN.flags).test(
      text,
    ) ||
    new RegExp(BEARER_PATTERN.source, BEARER_PATTERN.flags).test(text) ||
    containsJwt(text) ||
    new RegExp(
      AWS_ACCESS_KEY_PATTERN.source,
      AWS_ACCESS_KEY_PATTERN.flags,
    ).test(text) ||
    new RegExp(GITHUB_TOKEN_PATTERN.source, GITHUB_TOKEN_PATTERN.flags).test(
      text,
    ) ||
    credentialAssignmentRemains(text)
  ) {
    return true;
  }

  const authorization = text.match(
    /\bAuthorization\s*[:=]\s*([^\r\n]+)/iu,
  )?.[1];
  if (authorization && !isRedactedValue(authorization.trim())) return true;
  return urlsIn(text).some(urlContainsCredential);
}

function validateOptions(options: ServingQuestionRedactionOptions): void {
  const { maxInputBytes, maxTextBytes } = options;
  if (
    !Number.isSafeInteger(maxInputBytes) ||
    !Number.isSafeInteger(maxTextBytes) ||
    maxInputBytes <= 0 ||
    maxTextBytes <= 0 ||
    maxInputBytes > SERVING_REDACTION_HARD_MAX_INPUT_BYTES ||
    maxTextBytes > SERVING_REDACTION_HARD_MAX_TEXT_BYTES ||
    maxTextBytes > maxInputBytes
  ) {
    throw new ServingRedactionError("invalid_options");
  }
}

function redactServingQuestionInternal(
  input: string,
  options: ServingQuestionRedactionOptions,
): RedactedServingQuestion {
  validateOptions(options);
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    !input.isWellFormed()
  ) {
    return dropped("dropped_invalid");
  }
  if (Buffer.byteLength(input, "utf8") > options.maxInputBytes) {
    return dropped("dropped_invalid");
  }

  const labels = detectSensitiveLabels(input);
  let redacted: string;
  if (looksStructured(input)) {
    let parsed: unknown;
    try {
      parsed = parseStructured(input);
    } catch (error) {
      if (
        error instanceof YAMLException ||
        error instanceof UnsafeStructuredInputError
      ) {
        return dropped("dropped_sensitive", labels);
      }
      throw error;
    }

    try {
      const value = redactStructuredValue(parsed, 0, {
        active: new WeakSet(),
        labels,
        nodes: 0,
      });
      redacted = canonicalJson(value, "servingQuestion");
    } catch (error) {
      if (error instanceof UnsafeStructuredInputError) {
        return dropped("dropped_sensitive", labels);
      }
      throw error;
    }
  } else {
    redacted = redactText(input, labels);
  }

  if (Buffer.byteLength(redacted, "utf8") > options.maxTextBytes) {
    redacted = truncateUtf8(redacted, options.maxTextBytes);
    labels.add("truncated");
  }
  if (redacted.length === 0) return dropped("dropped_invalid", labels);
  if (containsSensitiveServingText(redacted)) {
    throw new ServingRedactionError("verification_failed");
  }
  return {
    disposition: "redacted",
    text: redacted,
    redactionVersion: SERVING_REDACTION_VERSION,
    redactionLabels: orderedLabels(labels),
  };
}

export function redactServingQuestion(
  input: string,
  options: ServingQuestionRedactionOptions,
): RedactedServingQuestion {
  try {
    return redactServingQuestionInternal(input, options);
  } catch (error) {
    if (error instanceof ServingRedactionError) throw error;
    throw new ServingRedactionError("redaction_internal");
  }
}
