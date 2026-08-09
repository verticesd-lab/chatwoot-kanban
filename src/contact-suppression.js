const CONTACT_SCOPE_REASONS = new Set([
  "lead de teste",
  "cadastro incorreto",
  "sem valor operacional",
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

module.exports = {
  CONTACT_SCOPE_REASONS,
  contactIdentity,
  isContactScopeArchive,
  archivedContactKeys,
};
