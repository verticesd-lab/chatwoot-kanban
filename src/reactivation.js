const DEFAULT_ELIGIBLE_LABELS = [
  "aguardando-cpf-terceiro",
  "fora-de-horario",
  "aguardando-retorno-cliente",
];

const DEFAULT_BLOCK_LABEL = "reativacao-unica-enviada";

const DEFAULT_TEMPLATES = [
  {
    key: "general",
    label: "Retomada geral",
    message:
      "Oi, {{primeiro_nome}}! Passando para saber se você ainda quer continuar sua análise para a moto. Se quiser, posso retomar seu atendimento por aqui. 🏍️",
  },
  {
    key: "third_party_cpf",
    label: "CPF de terceiros",
    message:
      "Oi, {{primeiro_nome}}! Você conseguiu verificar com a pessoa que faria a análise junto com você? Se quiser continuar, podemos retomar por aqui.",
  },
  {
    key: "after_hours",
    label: "Fora do horário",
    message:
      "Oi, {{primeiro_nome}}! Você falou com a gente fora do nosso horário e estou retomando seu atendimento. Se ainda estiver buscando sua moto, me chama por aqui que continuamos. 🏍️",
  },
  {
    key: "awaiting_return",
    label: "Aguardando retorno",
    message:
      "Oi, {{primeiro_nome}}! Passando para retomar seu atendimento. Se ainda quiser seguir com sua análise da moto, me chama por aqui e continuamos.",
  },
];

const LEGACY_LABEL_ALIASES = Object.freeze({
  "aguardando-cpf-de-terceiros": "aguardando-cpf-terceiro",
  "fora-do-horario": "fora-de-horario",
  "aguardando-retorno-do-cliente": "aguardando-retorno-cliente",
});

function normalizeLabel(value) {
  const normalized = String(value || "")
    .trim()
    .toLocaleLowerCase("pt-BR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return LEGACY_LABEL_ALIASES[normalized] || normalized;
}

function parseEligibleLabels(value) {
  const source = String(value || "").trim();
  const labels = source
    ? source.split(",").map((item) => item.trim()).filter(Boolean)
    : DEFAULT_ELIGIBLE_LABELS;
  return [...new Set(labels.map(normalizeLabel).filter(Boolean))];
}

function reactivationConfig(env = process.env) {
  const maxRecipients = Math.min(250, Math.max(1, Number(env.REACTIVATION_MAX_RECIPIENTS || 100)));
  const intervalMs = Math.min(60000, Math.max(1000, Number(env.REACTIVATION_WORKER_INTERVAL_MS || 3000)));
  return {
    sendEnabled: String(env.REACTIVATION_SEND_ENABLED || "false").toLowerCase() === "true",
    eligibleLabels: parseEligibleLabels(env.REACTIVATION_ELIGIBLE_LABELS),
    blockLabel: normalizeLabel(env.REACTIVATION_BLOCK_LABEL || DEFAULT_BLOCK_LABEL),
    maxRecipients,
    intervalMs,
    templates: DEFAULT_TEMPLATES.map((template) => ({ ...template })),
  };
}

function conversationLabels(conversation) {
  const raw = conversation?.labels || conversation?.label_list || [];
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((label) => normalizeLabel(label?.title || label?.name || label)).filter(Boolean))];
}

function matchingEligibilityLabels(conversation, allowedLabels) {
  const labels = new Set(conversationLabels(conversation));
  return (allowedLabels || []).filter((label) => labels.has(normalizeLabel(label)));
}

function hasBlockLabel(conversation, blockLabel) {
  const target = normalizeLabel(blockLabel);
  return target ? conversationLabels(conversation).includes(target) : false;
}

function getTimestamp(value) {
  if (!value) return null;
  if (typeof value === "number") return value > 1000000000000 ? value : value * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function conversationActivityTimestamp(conversation) {
  return (
    getTimestamp(conversation?.last_activity_at) ||
    getTimestamp(conversation?.updated_at) ||
    getTimestamp(conversation?.created_at) ||
    0
  );
}

function periodStart(period, now = Date.now()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const start = today.getTime();
  if (period === "today") return start;
  if (period === "3d") return start - 2 * 86400000;
  if (period === "7d") return start - 6 * 86400000;
  if (period === "14d") return start - 13 * 86400000;
  if (period === "30d") return start - 29 * 86400000;
  return -Infinity;
}

function matchesPeriod(conversation, period) {
  if (!period || period === "all") return true;
  return conversationActivityTimestamp(conversation) >= periodStart(period);
}

function senderForConversation(conversation) {
  return conversation?.meta?.sender || conversation?.sender || {};
}

function firstName(value) {
  const name = String(value || "").trim();
  if (!name) return "";
  return name.split(/\s+/)[0].replace(/[{}<>]/g, "").slice(0, 50);
}

function validateManualSourceReason(value) {
  const reason = String(value || "").trim().replace(/\s+/g, " ");
  if (reason.length < 3) {
    const error = new Error("Informe o motivo da inclusão manual");
    error.status = 400;
    throw error;
  }
  if (reason.length > 160) {
    const error = new Error("O motivo da inclusão manual deve possuir no máximo 160 caracteres");
    error.status = 400;
    throw error;
  }
  return reason;
}

function validateMessageTemplate(value) {
  const message = String(value || "").trim();
  if (!message) {
    const error = new Error("Escreva a mensagem da reativação");
    error.status = 400;
    throw error;
  }
  if (message.length > 1200) {
    const error = new Error("A mensagem da reativação deve possuir no máximo 1200 caracteres");
    error.status = 400;
    throw error;
  }
  const placeholders = [...message.matchAll(/{{\s*([^}]+?)\s*}}/g)].map((match) => match[1]);
  const unsupported = placeholders.filter((name) => name !== "primeiro_nome");
  if (unsupported.length) {
    const error = new Error(`Variável não suportada: {{${unsupported[0]}}}`);
    error.status = 400;
    throw error;
  }
  return message;
}

function renderMessage(template, conversation) {
  const message = validateMessageTemplate(template);
  const sender = senderForConversation(conversation);
  const name = firstName(sender.name) || "tudo bem";
  return message.replace(/{{\s*primeiro_nome\s*}}/g, name);
}

function crmStage(conversation) {
  return String(conversation?.custom_attributes?.crm_stage || "new").trim().toLowerCase();
}

function terminalStage(conversation) {
  return ["won", "lost"].includes(crmStage(conversation));
}

function isIncomingMessage(message) {
  const type = message?.message_type;
  return Number(type) === 0 || String(type || "").toLowerCase() === "incoming";
}

function latestIncomingAfter(conversation, isoTimestamp) {
  const since = getTimestamp(isoTimestamp);
  if (!since) return null;
  const candidates = [];
  if (conversation?.last_non_activity_message) candidates.push(conversation.last_non_activity_message);
  if (Array.isArray(conversation?.messages)) candidates.push(...conversation.messages);
  let latest = null;
  for (const message of candidates) {
    if (!message || !isIncomingMessage(message)) continue;
    const timestamp =
      getTimestamp(message.created_at) ||
      getTimestamp(message.updated_at) ||
      0;
    if (timestamp > since && (!latest || timestamp > latest)) latest = timestamp;
  }
  return latest ? new Date(latest).toISOString() : null;
}

function candidateSnapshot(conversation, config, options = {}) {
  const sender = senderForConversation(conversation);
  const labels = conversationLabels(conversation);
  const matchedLabels = matchingEligibilityLabels(conversation, options.selectedLabels || config.eligibleLabels);
  return {
    conversationId: Number(conversation.id),
    contactId: sender.id ? Number(sender.id) : null,
    contactName: String(sender.name || `Contato #${conversation.id}`).trim().slice(0, 120),
    phone: String(sender.phone_number || "").trim().slice(0, 80),
    email: String(sender.email || "").trim().slice(0, 160),
    labels,
    matchedLabels,
    stage: crmStage(conversation),
    lastActivityAt: conversationActivityTimestamp(conversation)
      ? new Date(conversationActivityTimestamp(conversation)).toISOString()
      : null,
    hasBlockLabel: hasBlockLabel(conversation, config.blockLabel),
    terminal: terminalStage(conversation),
  };
}

module.exports = {
  DEFAULT_BLOCK_LABEL,
  DEFAULT_ELIGIBLE_LABELS,
  DEFAULT_TEMPLATES,
  normalizeLabel,
  parseEligibleLabels,
  reactivationConfig,
  conversationLabels,
  matchingEligibilityLabels,
  hasBlockLabel,
  matchesPeriod,
  senderForConversation,
  validateMessageTemplate,
  validateManualSourceReason,
  renderMessage,
  terminalStage,
  latestIncomingAfter,
  candidateSnapshot,
};
