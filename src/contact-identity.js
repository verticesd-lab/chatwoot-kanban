function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

function canonicalPhone(value) {
  let digits = digitsOnly(value);
  if (!digits) return "";

  // Normalize international dialing prefix when present.
  if (digits.startsWith("00")) digits = digits.slice(2);

  // AutoCredit currently operates in Brazil. Chatwoot/Evolution may persist the
  // same Brazilian mobile with or without country code, so normalize local forms.
  if (!digits.startsWith("55") && (digits.length === 10 || digits.length === 11)) {
    digits = `55${digits}`;
  }

  if (digits.startsWith("55")) {
    const national = digits.slice(2);
    if (national.length === 10) {
      const ddd = national.slice(0, 2);
      const subscriber = national.slice(2);
      // Legacy Brazilian mobile records can omit the ninth digit. Only expand
      // 8-digit subscribers that look mobile (6-9); landlines remain unchanged.
      if (/^[6-9]/.test(subscriber)) {
        digits = `55${ddd}9${subscriber}`;
      }
    }
  }

  return digits;
}

function senderFromConversation(conversation) {
  return conversation?.meta?.sender || conversation?.sender || {};
}

function conversationIdentity(conversation) {
  const sender = senderFromConversation(conversation);
  const contactId = Number(sender?.id || 0);
  const phone = String(sender?.phone_number || "").trim();
  return {
    contactId: Number.isInteger(contactId) && contactId > 0 ? contactId : null,
    phone,
    canonicalPhone: canonicalPhone(phone),
  };
}

function webhookIdentity(payload) {
  const sender =
    payload?.sender ||
    payload?.message?.sender ||
    payload?.conversation?.meta?.sender ||
    payload?.conversation?.sender ||
    payload?.contact ||
    {};

  const contactId = Number(sender?.id || payload?.sender_id || 0);
  const phone = String(
    sender?.phone_number ||
    payload?.phone_number ||
    payload?.conversation?.meta?.sender?.phone_number ||
    ""
  ).trim();

  return {
    contactId: Number.isInteger(contactId) && contactId > 0 ? contactId : null,
    phone,
    canonicalPhone: canonicalPhone(phone),
  };
}

function identityKey({ canonicalPhone: phone, contactId, conversationId } = {}) {
  const normalizedPhone = canonicalPhone(phone);
  if (normalizedPhone) return `phone:${normalizedPhone}`;
  const normalizedContactId = Number(contactId || 0);
  if (Number.isInteger(normalizedContactId) && normalizedContactId > 0) {
    return `contact:${normalizedContactId}`;
  }
  const normalizedConversationId = Number(conversationId || 0);
  if (Number.isInteger(normalizedConversationId) && normalizedConversationId > 0) {
    return `conversation:${normalizedConversationId}`;
  }
  return "";
}

function recipientMatchesConversation(recipient, conversation) {
  if (!recipient || !conversation) return false;
  const conversationId = Number(conversation.id || 0);
  if (conversationId > 0 && conversationId === Number(recipient.conversationId || 0)) return true;

  const identity = conversationIdentity(conversation);
  if (
    identity.contactId &&
    recipient.contactId &&
    Number(identity.contactId) === Number(recipient.contactId)
  ) {
    return true;
  }

  const recipientPhone = canonicalPhone(recipient.canonicalPhone || recipient.phone);
  return Boolean(recipientPhone && identity.canonicalPhone && recipientPhone === identity.canonicalPhone);
}

module.exports = {
  digitsOnly,
  canonicalPhone,
  senderFromConversation,
  conversationIdentity,
  webhookIdentity,
  identityKey,
  recipientMatchesConversation,
};
