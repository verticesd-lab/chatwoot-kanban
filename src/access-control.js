const INTERVENTION_LABELS = new Set(["precisa-humano", "atendimento-manual"]);
const SDR_QUEUE_LABELS = new Set([
  "aguardando-analise-manual",
  "precisa-humano",
  "atendimento-manual",
]);

function normalizeText(value) {
  return String(value || "").trim().toLocaleLowerCase("pt-BR");
}

function normalizeLabelKey(value) {
  return normalizeText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function labelNames(conversation) {
  const labels = conversation?.labels || conversation?.label_list || [];
  if (!Array.isArray(labels)) return [];
  return [...new Set(labels.map((label) => String(label?.title || label?.name || label || "").trim()).filter(Boolean))];
}

function extractAssigneeId(conversation) {
  const raw =
    conversation?.meta?.assignee?.id ??
    conversation?.assignee?.id ??
    conversation?.assignee_id ??
    conversation?.meta?.assignee_id ??
    null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isInterventionConversation(conversation) {
  return labelNames(conversation).some((label) => INTERVENTION_LABELS.has(normalizeLabelKey(label)));
}

function interventionLabels(conversation) {
  return labelNames(conversation).filter((label) => INTERVENTION_LABELS.has(normalizeLabelKey(label)));
}

function isSdrQueueConversation(conversation) {
  return labelNames(conversation).some((label) => SDR_QUEUE_LABELS.has(normalizeLabelKey(label)));
}

function hasConversationAccess(session, conversation) {
  const scope = String(session?.visibility_scope || session?.visibilityScope || "all");
  if (scope === "all") return true;

  const operationalRole = String(
    session?.operational_role || session?.operationalRole || ""
  ).toLowerCase();
  const linkedAgentId = Number(session?.chatwoot_agent_id || session?.chatwootAgentId || 0);
  const assigneeId = extractAssigneeId(conversation);
  const isLinkedAgent = linkedAgentId > 0 && assigneeId === linkedAgentId;

  if (scope === "mine") {
    return isLinkedAgent;
  }

  // Para SDR, "sem responsável" não significa todo o histórico sem agente.
  // Significa somente a fila operacional sinalizada pelos fluxos/AutoCore.
  // Leads já atribuídos à própria SDR continuam visíveis mesmo sem etiqueta.
  if (operationalRole === "sdr") {
    const isEligibleUnassigned = assigneeId === null && isSdrQueueConversation(conversation);
    if (scope === "unassigned_and_mine") return isEligibleUnassigned || isLinkedAgent;
    if (scope === "unassigned") return isEligibleUnassigned;
  }

  if (scope === "unassigned_and_mine") {
    return assigneeId === null || isLinkedAgent;
  }
  if (scope === "unassigned") {
    return assigneeId === null;
  }
  return false;
}

function filterConversationsForSession(session, conversations) {
  return (Array.isArray(conversations) ? conversations : []).filter((conversation) =>
    hasConversationAccess(session, conversation)
  );
}

function taskStatus(conversation, now = Date.now()) {
  const attributes = conversation?.custom_attributes || {};
  const title = String(attributes.crm_next_task || "").trim();
  if (!title) return "none";
  const done = attributes.crm_task_done === true || String(attributes.crm_task_done).toLowerCase() === "true";
  if (done) return "done";
  const due = String(attributes.crm_task_due_at || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    const timestamp = Date.parse(`${due}T23:59:59`);
    if (Number.isFinite(timestamp) && timestamp < now) return "overdue";
  }
  return "pending";
}

function activityTimestamp(conversation) {
  const raw = conversation?.last_activity_at ?? conversation?.updated_at ?? conversation?.created_at ?? 0;
  if (typeof raw === "number") return raw > 1e12 ? raw : raw * 1000;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function operationalPriority(conversation, now = Date.now()) {
  if (isInterventionConversation(conversation)) return 0;
  if (taskStatus(conversation, now) === "overdue") return 1;

  const attributes = conversation?.custom_attributes || {};
  const due = String(attributes.crm_task_due_at || "");
  const today = new Date(now);
  const todayKey = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, "0"), String(today.getDate()).padStart(2, "0")].join("-");
  if (taskStatus(conversation, now) === "pending" && due === todayKey) return 2;

  const assigneeId = extractAssigneeId(conversation);
  if (!assigneeId) return 3;

  const inactiveFor = now - activityTimestamp(conversation);
  if (inactiveFor >= 24 * 60 * 60 * 1000) return 4;
  if (!String(attributes.crm_next_task || "").trim()) return 5;
  return 6;
}

function sortOperationalQueue(conversations, now = Date.now()) {
  return [...(Array.isArray(conversations) ? conversations : [])].sort((a, b) => {
    const priorityDiff = operationalPriority(a, now) - operationalPriority(b, now);
    if (priorityDiff !== 0) return priorityDiff;
    return activityTimestamp(b) - activityTimestamp(a);
  });
}

module.exports = {
  INTERVENTION_LABELS,
  SDR_QUEUE_LABELS,
  labelNames,
  extractAssigneeId,
  isInterventionConversation,
  interventionLabels,
  isSdrQueueConversation,
  hasConversationAccess,
  filterConversationsForSession,
  taskStatus,
  activityTimestamp,
  operationalPriority,
  sortOperationalQueue,
};
