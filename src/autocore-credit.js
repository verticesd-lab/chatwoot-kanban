const axios = require("axios");

const DEFAULT_LIMIT = 50;
const DEFAULT_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;
const MAX_TEXT_LENGTH = 160;
const PERIOD_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/;

class CreditGatewayError extends Error {
  constructor(code) {
    super("Falha ao consultar a central de crédito");
    this.name = "CreditGatewayError";
    this.code = code;
  }
}

function emptyCreditOperations() {
  return {
    enabled: false,
    readOnly: true,
    metrics: {
      cpfCollectedToday: 0,
      processing: 0,
      waitingInput: 0,
      attentionRequired: 0,
    },
    items: [],
  };
}

function parsePositiveInteger(value) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseLimit(value, fallback = DEFAULT_LIMIT) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = parsePositiveInteger(value);
  if (parsed === null || parsed > 100) throw new CreditGatewayError("INVALID_LIMIT");
  return parsed;
}

function parsePeriodTimestamp(value) {
  if (typeof value !== "string") throw new CreditGatewayError("INVALID_PERIOD");
  const match = PERIOD_TIMESTAMP_PATTERN.exec(value);
  if (!match) throw new CreditGatewayError("INVALID_PERIOD");

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] || "";
  const timezone = match[8];
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1
    || month > 12
    || day < 1
    || day > daysInMonth[month - 1]
    || hour > 23
    || minute > 59
    || second > 59
  ) {
    throw new CreditGatewayError("INVALID_PERIOD");
  }

  let offsetMinutes = 0;
  if (timezone !== "Z") {
    const offsetHour = Number(timezone.slice(1, 3));
    const offsetMinute = Number(timezone.slice(4, 6));
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
      throw new CreditGatewayError("INVALID_PERIOD");
    }
    offsetMinutes = (offsetHour * 60 + offsetMinute) * (timezone[0] === "+" ? 1 : -1);
  }

  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, 0);
  return {
    epochSecond: Math.floor(local.getTime() / 1000) - offsetMinutes * 60,
    fraction,
  };
}

function comparePeriodTimestamps(left, right) {
  if (left.epochSecond !== right.epochSecond) {
    return left.epochSecond < right.epochSecond ? -1 : 1;
  }
  const length = Math.max(left.fraction.length, right.fraction.length);
  const leftFraction = left.fraction.padEnd(length, "0");
  const rightFraction = right.fraction.padEnd(length, "0");
  if (leftFraction === rightFraction) return 0;
  return leftFraction < rightFraction ? -1 : 1;
}

function validateCreditPeriod({ from, to } = {}) {
  const period = {};
  let parsedFrom;
  let parsedTo;
  if (from !== undefined) {
    parsedFrom = parsePeriodTimestamp(from);
    period.from = from;
  }
  if (to !== undefined) {
    parsedTo = parsePeriodTimestamp(to);
    period.to = to;
  }
  if (parsedFrom && parsedTo && comparePeriodTimestamps(parsedFrom, parsedTo) >= 0) {
    throw new CreditGatewayError("INVALID_PERIOD");
  }
  return period;
}

function creditPanelEnabled(env = process.env) {
  return String(env.CREDIT_PANEL_ENABLED || "").trim().toLowerCase() === "true";
}

function readCreditConfig(env = process.env) {
  const token = String(env.AUTOCORE_CREDIT_OPERATIONS_TOKEN || "").trim();
  const storeId = parsePositiveInteger(env.AUTOCORE_CREDIT_OPERATIONS_STORE_ID);
  const timeoutMs = env.AUTOCORE_CREDIT_OPERATIONS_TIMEOUT_MS === undefined
    || String(env.AUTOCORE_CREDIT_OPERATIONS_TIMEOUT_MS).trim() === ""
    ? DEFAULT_TIMEOUT_MS
    : parsePositiveInteger(env.AUTOCORE_CREDIT_OPERATIONS_TIMEOUT_MS);

  let baseUrl;
  try {
    baseUrl = new URL(String(env.AUTOCORE_INTERNAL_BASE_URL || "").trim());
  } catch (_error) {
    throw new CreditGatewayError("INVALID_CONFIG");
  }

  const validProtocol = baseUrl.protocol === "http:" || baseUrl.protocol === "https:";
  const hasUserInfo = Boolean(baseUrl.username || baseUrl.password);
  const writeEnabled = String(env.CREDIT_PANEL_WRITE_ENABLED || "").trim().toLowerCase() === "true";
  if (
    !validProtocol
    || hasUserInfo
    || baseUrl.search
    || baseUrl.hash
    || token.length < 32
    || storeId === null
    || timeoutMs === null
    || timeoutMs < MIN_TIMEOUT_MS
    || timeoutMs > MAX_TIMEOUT_MS
    || writeEnabled
  ) {
    throw new CreditGatewayError("INVALID_CONFIG");
  }

  baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, "")}/internal/credit/operations`;
  return {
    url: baseUrl.toString(),
    token,
    storeId,
    timeoutMs,
  };
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeText(value, maxLength = MAX_TEXT_LENGTH) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maxLength ? text : null;
}

function safeCanonical(value, maxLength = 80) {
  const text = safeText(value, maxLength);
  return text && /^[a-zA-Z0-9._:-]+$/.test(text) ? text : null;
}

function safeTimestamp(value) {
  const text = safeText(value, 40);
  return text && !Number.isNaN(Date.parse(text)) ? text : null;
}

function safeNullableBoolean(value) {
  return value === true || value === false || value === null ? value : null;
}

function sanitizeDownPayment(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const known = source.known === true && Number.isSafeInteger(source.cents) && source.cents >= 0;
  const cents = known ? source.cents : null;
  return { known, cents };
}

function sanitizeFacts(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    cpfPresent: source.cpfPresent === true,
    birthDatePresent: source.birthDatePresent === true,
    phonePresent: source.phonePresent === true,
    emailPresent: source.emailPresent === true,
    cnhPresent: source.cnhPresent === true,
    downPayment: sanitizeDownPayment(source.downPayment),
  };
}

function sanitizeBank(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const code = safeCanonical(value.code, 32);
  const status = safeCanonical(value.status);
  if (!code || !status) return null;
  const missingFields = Array.isArray(value.missingFields)
    ? value.missingFields.map((field) => safeCanonical(field)).filter(Boolean).slice(0, 30)
    : [];
  return {
    code,
    name: safeText(value.name),
    status,
    available: safeNullableBoolean(value.available),
    missingFields,
  };
}

function sanitizeJob(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const type = safeCanonical(value.type);
  const status = safeCanonical(value.status);
  if (!type || !status) return null;
  return {
    type,
    status,
    attempts: safeCount(value.attempts),
    maxAttempts: safeCount(value.maxAttempts),
    createdAt: safeTimestamp(value.createdAt),
    updatedAt: safeTimestamp(value.updatedAt),
  };
}

function sanitizeItem(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const conversationId = safeCanonical(value.conversationId, 64);
  const status = safeCanonical(value.status);
  if (!conversationId || !status) return null;

  const item = {
    conversationId,
    stateUuid: safeCanonical(value.stateUuid, 80),
    revision: safeCount(value.revision),
    applicantAttempt: safeCount(value.applicantAttempt),
    status,
    facts: sanitizeFacts(value.facts),
    banks: Array.isArray(value.banks) ? value.banks.map(sanitizeBank).filter(Boolean).slice(0, 50) : [],
    job: sanitizeJob(value.job),
    nextAction: value.nextAction === null ? null : safeCanonical(value.nextAction),
    createdAt: safeTimestamp(value.createdAt),
    updatedAt: safeTimestamp(value.updatedAt),
  };
  if (typeof value.cpfLast4 === "string" && /^\d{4}$/.test(value.cpfLast4)) item.cpfLast4 = value.cpfLast4;
  return item;
}

function sanitizeCreditOperations(value, configuredStoreId) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.readOnly !== true) {
    throw new CreditGatewayError("INVALID_UPSTREAM_CONTRACT");
  }
  if (!value.metrics || typeof value.metrics !== "object" || !Array.isArray(value.items)) {
    throw new CreditGatewayError("INVALID_UPSTREAM_CONTRACT");
  }
  const metrics = value.metrics;
  return {
    enabled: value.enabled === true,
    readOnly: true,
    generatedAt: safeTimestamp(value.generatedAt),
    storeId: configuredStoreId,
    metrics: {
      cpfCollectedToday: safeCount(metrics.cpfCollectedToday),
      processing: safeCount(metrics.processing),
      waitingInput: safeCount(metrics.waitingInput),
      attentionRequired: safeCount(metrics.attentionRequired),
    },
    items: value.items.map(sanitizeItem).filter(Boolean).slice(0, 100),
  };
}

async function fetchCreditOperations({
  limit,
  from,
  to,
  env = process.env,
  httpClient = axios,
} = {}) {
  const config = readCreditConfig(env);
  const validatedLimit = parseLimit(limit);
  const period = validateCreditPeriod({ from, to });
  const params = { store_id: config.storeId, limit: validatedLimit };
  if (period.from !== undefined) params.from = period.from;
  if (period.to !== undefined) params.to = period.to;
  try {
    const response = await httpClient.get(config.url, {
      params,
      headers: { Authorization: `Bearer ${config.token}` },
      timeout: config.timeoutMs,
      maxRedirects: 0,
      proxy: false,
      responseType: "json",
      validateStatus: (status) => status >= 200 && status < 300,
    });
    return sanitizeCreditOperations(response.data, config.storeId);
  } catch (error) {
    if (error instanceof CreditGatewayError) throw error;
    throw new CreditGatewayError("UPSTREAM_UNAVAILABLE");
  }
}

module.exports = {
  CreditGatewayError,
  creditPanelEnabled,
  emptyCreditOperations,
  fetchCreditOperations,
  parseLimit,
  readCreditConfig,
  sanitizeCreditOperations,
  validateCreditPeriod,
};
