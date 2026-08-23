const access = require("./access-control");

const CONTACT_SCOPE_REASONS = new Set([
  "lead de teste",
  "cadastro incorreto",
  "sem valor operacional",
]);

const RESOLVED_ARCHIVE_INACTIVITY_MS = 7 * 24 * 60 * 60 * 1000;

const STRONG_OPERATIONAL_STAGES = new Set([
  "contacted",
  "qualification",
  "proposal",
  "negotiation",
  "nova_tentativa_cpf",
  "analise_manual",
  "credito_aprovado",
  "sem_resposta_follow_up",
  "sem_resposta_followup",
]);

const STRONG_OPERATIONAL_LABELS = new Set([
  "precisa-humano",
  "atendimento-manual",
  "aguardando-analise-manual",
  "aguardando-cpf-terceiro",
  "aguardando-retorno-cliente",
  "lead-com-sdr",
]);

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function contactIdentity(conversation) {
  const sender = conversation?.meta?.sender || conversation?.sender || {};
  const phone = String(sender?.phone_number || "").replace(/\D/g, "");
  if (phone) return `phone:${phone}`;

  const identifier = String(sender?.identifier || "").trim().toLowerCase();
  if (identifier) return `identifier:${identifier}`;

  const email = String(sender?.email || "").trim().toLowerCase();
  if (email) return `email:${email}`;

  const senderId = Number(sender?.id || 0);
  if (Number.isInteger(senderId) && senderId > 0) return `contact:${senderId}`;

  const conversationId = Number(conversation?.id || 0);
  return conversationId > 0 ? `conversation:${conversationId}` : "";
}

function isContactScopeArchive(item) {
  const scope = String(item?.archiveScope || item?.archive_scope || "").trim().toLowerCase();
  if (scope === "contact") return true;
  if (scope === "conversation") {
    // Registros antigos foram criados antes de existir archive_scope.
    // Para os motivos operacionais abaixo, preservamos a intenção de
    // retirar o lead inteiro da rotina, mesmo que o banco tenha aplicado
    // o default "conversation" ao adicionar a coluna.
    return CONTACT_SCOPE_REASONS.has(normalizeText(item?.reason));
  }
  return CONTACT_SCOPE_REASONS.has(normalizeText(item?.reason));
}

function archivedContactKeys(conversations, archivedItems) {
  const byConversationId = new Map(
    (Array.isArray(conversations) ? conversations : []).map((conversation) => [
      Number(conversation?.id),
      conversation,
    ])
  );

  const keys = new Set();
  for (const item of Array.isArray(archivedItems) ? archivedItems : []) {
    if (!isContactScopeArchive(item)) continue;

    const persistedKey = String(item?.contactKey || item?.contact_key || "").trim();
    if (persistedKey) {
      keys.add(persistedKey);
      continue;
    }

    const conversation = byConversationId.get(Number(item?.conversationId || item?.conversation_id));
    const key = contactIdentity(conversation);
    if (key) keys.add(key);
  }
  return keys;
}

function normalizeOperationalLabel(value) {
  return normalizeText(value)
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function hasStrongOperationalSignal(conversation, now = Date.now()) {
  const attributes = conversation?.custom_attributes || {};
  const stage = String(attributes.crm_stage || "").trim();
  if (STRONG_OPERATIONAL_STAGES.has(stage)) return true;

  const qualificationPhase = String(attributes.fase_qualificacao || "").trim().toLowerCase();
  if (qualificationPhase.startsWith("aguardando_")) return true;

  if (["pending", "overdue"].includes(access.taskStatus(conversation, now))) return true;

  return access.labelNames(conversation).some((label) =>
    STRONG_OPERATIONAL_LABELS.has(normalizeOperationalLabel(label))
  );
}

function isOlderThanResolvedArchiveWindow(conversation, now = Date.now()) {
  const lastActivityAt = access.activityTimestamp(conversation);
  return lastActivityAt > 0 && now - lastActivityAt > RESOLVED_ARCHIVE_INACTIVITY_MS;
}

function parseHistoricalCutoff(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;

  const timestamp = String(value).trim();
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(timestamp)) {
    throw new Error("CHATWOOT_RESOLVED_ARCHIVE_HISTORICAL_CUTOFF exige timezone explicito");
  }
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    throw new Error("CHATWOOT_RESOLVED_ARCHIVE_HISTORICAL_CUTOFF invalido");
  }
  return parsed;
}

function isBeforeHistoricalCutoff(conversation, historicalCutoff = null) {
  const cutoff = parseHistoricalCutoff(historicalCutoff);
  if (cutoff === null) return false;
  const lastActivityAt = access.activityTimestamp(conversation);
  return lastActivityAt > 0 && lastActivityAt < cutoff;
}

function shouldClassifyAsChatwootResolved(
  conversation,
  now = Date.now(),
  historicalCutoff = null
) {
  if (conversation?.status !== "resolved") return false;
  if (isBeforeHistoricalCutoff(conversation, historicalCutoff)) return true;
  return isOlderThanResolvedArchiveWindow(conversation, now) &&
    !hasStrongOperationalSignal(conversation, now);
}

function classifyWorkspaceConversation(
  conversation,
  {
    manuallyArchived = false,
    contactSuppressed = false,
    now = Date.now(),
    historicalCutoff = null,
  } = {}
) {
  if (manuallyArchived) return "manual_archive";
  if (contactSuppressed) return "contact_suppressed";
  if (shouldClassifyAsChatwootResolved(conversation, now, historicalCutoff)) {
    return "chatwoot_resolved";
  }
  return "active";
}

function bucketWorkspaceConversations(conversations, flagsForConversation = () => ({})) {
  const buckets = {
    active: [],
    manualArchived: [],
    contactSuppressed: [],
    chatwootResolved: [],
  };
  const bucketByClassification = {
    active: "active",
    manual_archive: "manualArchived",
    contact_suppressed: "contactSuppressed",
    chatwoot_resolved: "chatwootResolved",
  };

  for (const conversation of Array.isArray(conversations) ? conversations : []) {
    const classification = classifyWorkspaceConversation(
      conversation,
      flagsForConversation(conversation) || {}
    );
    buckets[bucketByClassification[classification]].push(conversation);
  }

  return buckets;
}

module.exports = {
  CONTACT_SCOPE_REASONS,
  contactIdentity,
  isContactScopeArchive,
  archivedContactKeys,
  hasStrongOperationalSignal,
  isOlderThanResolvedArchiveWindow,
  parseHistoricalCutoff,
  isBeforeHistoricalCutoff,
  shouldClassifyAsChatwootResolved,
  classifyWorkspaceConversation,
  bucketWorkspaceConversations,
};
