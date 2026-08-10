const express = require("express");
const axios = require("axios");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config();
const db = require("./db");
const access = require("./access-control");
const suppression = require("./contact-suppression");
const reactivation = require("./reactivation");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL_MS = Number(process.env.CRM_SESSION_TTL_HOURS || 12) * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const loginAttempts = new Map();
const REACTIVATION_CONFIG = reactivation.reactivationConfig(process.env);
let reactivationWorkerBusy = false;

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) throw new Error("BASE_URL não configurada");
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

const DEFAULT_CHATWOOT_BASE_URL = normalizeBaseUrl(process.env.BASE_URL);
const bootstrap = db.bootstrapFromEnv(DEFAULT_CHATWOOT_BASE_URL);
if (bootstrap.bootstrapped) {
  console.log("Fundação CRM inicializada a partir das variáveis de ambiente.");
}

app.set("trust proxy", true);
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://i.ytimg.com; connect-src 'self'; frame-src https://www.youtube-nocookie.com https://www.youtube.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  next();
});
app.use(express.json({ limit: "1mb" }));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/script.js", (_req, res) => res.sendFile(path.join(__dirname, "script.js")));
app.get("/styles.css", (_req, res) => res.sendFile(path.join(__dirname, "styles.css")));
app.use(
  "/assets",
  express.static(path.join(__dirname, "assets"), {
    maxAge: "1h",
  })
);

function parseCookies(header = "") {
  return header.split(";").reduce((cookies, part) => {
    const index = part.indexOf("=");
    if (index < 0) return cookies;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function isSecureRequest(req) {
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

function sessionCookie(sessionId, req) {
  const secure = isSecureRequest(req) ? "; Secure" : "";
  return `crm_session=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(
    SESSION_TTL_MS / 1000
  )}${secure}`;
}

function clearSessionCookie(req) {
  const secure = isSecureRequest(req) ? "; Secure" : "";
  return `crm_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

function getRawSessionToken(req) {
  return parseCookies(req.headers.cookie || "").crm_session || "";
}

function requireSession(req, res, next) {
  const session = db.getSession(getRawSessionToken(req));
  if (!session) return res.status(401).json({ error: "Sessão não autenticada ou expirada" });
  req.crmSession = session;
  db.touchPresence({
    organizationId: session.organization_id,
    userId: session.user_id,
    path: req.path,
    action: !["GET", "HEAD", "OPTIONS"].includes(req.method),
  });
  next();
}

function hasPermission(session, permission) {
  return session.permissions.includes(permission);
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!hasPermission(req.crmSession, permission)) {
      return res.status(403).json({ error: "Seu perfil não possui permissão para esta ação" });
    }
    next();
  };
}

function chatwootHeaders(token) {
  return { api_access_token: token, "Content-Type": "application/json" };
}

async function chatwootRequest(session, options) {
  return axios({
    timeout: 20000,
    validateStatus: () => true,
    ...options,
    headers: {
      ...chatwootHeaders(session.chatwootToken),
      ...(options.headers || {}),
    },
  });
}

function relayAxiosResponse(res, response) {
  const contentType = response.headers?.["content-type"];
  if (contentType) res.setHeader("content-type", contentType);
  return res.status(response.status).send(response.data);
}

function extractConversation(data) {
  return data?.data || data?.payload || data || null;
}

async function fetchConversation(session, conversationId) {
  const response = await chatwootRequest(session, {
    method: "GET",
    url: `${session.chatwoot_base_url}/api/v1/accounts/${session.chatwoot_account_id}/conversations/${conversationId}`,
  });
  return {
    response,
    conversation: response.status >= 200 && response.status < 300
      ? extractConversation(response.data)
      : null,
  };
}

async function fetchConversationMessages(session, conversationId) {
  const response = await chatwootRequest(session, {
    method: "GET",
    url: `${session.chatwoot_base_url}/api/v1/accounts/${session.chatwoot_account_id}/conversations/${conversationId}/messages`,
  });
  return {
    response,
    messages: response.status >= 200 && response.status < 300
      ? extractPayload(response.data)
      : [],
  };
}

async function requireConversationAccess(req, res, conversationId) {
  const fetched = await fetchConversation(req.crmSession, conversationId);
  if (!fetched.conversation) {
    relayAxiosResponse(res, fetched.response);
    return null;
  }
  if (!access.hasConversationAccess(req.crmSession, fetched.conversation)) {
    res.status(403).json({ error: "Esta conversa não pertence ao seu escopo operacional" });
    return null;
  }
  return fetched.conversation;
}

async function fetchAllChatwootConversations(session) {
  const conversations = [];
  const seen = new Set();
  for (let page = 1; page <= 200; page += 1) {
    const response = await chatwootRequest(session, {
      method: "GET",
      url: `${session.chatwoot_base_url}/api/v1/accounts/${session.chatwoot_account_id}/conversations?status=all&assignee_type=all&page=${page}`,
    });
    if (response.status < 200 || response.status >= 300) {
      const error = new Error("Falha ao carregar as conversas do Chatwoot");
      error.status = response.status;
      error.response = response.data;
      throw error;
    }
    const payload = extractPayload(response.data);
    if (!Array.isArray(payload) || payload.length === 0) break;
    for (const conversation of payload) {
      if (!seen.has(conversation.id)) {
        seen.add(conversation.id);
        conversations.push(conversation);
      }
    }
    if (payload.length < 25) break;
  }
  return conversations;
}


async function fetchScopedActiveConversations(session) {
  const allConversations = await fetchAllChatwootConversations(session);
  const scopedConversations = access.filterConversationsForSession(session, allConversations);
  const archivedItems = db.listArchivedOpportunities(session.organization_id);
  const archivedByConversation = new Map(
    archivedItems.map((item) => [Number(item.conversationId), item])
  );
  const archivedContactKeys = suppression.archivedContactKeys(allConversations, archivedItems);
  return scopedConversations.filter((conversation) => {
    if (archivedByConversation.has(Number(conversation.id))) return false;
    const contactKey = suppression.contactIdentity(conversation);
    return !contactKey || !archivedContactKeys.has(contactKey);
  });
}

function reactivationProtectionReason(session, conversation, options = {}) {
  if (!conversation) return "Conversa não encontrada no escopo atual";
  if (reactivation.terminalStage(conversation)) return "Oportunidade já encerrada no CRM";
  if (reactivation.hasBlockLabel(conversation, REACTIVATION_CONFIG.blockLabel)) {
    return `Etiqueta de proteção “${REACTIVATION_CONFIG.blockLabel}” já aplicada`;
  }
  const protectionStatus = db.getReactivationProtectionStatus(
    session.organization_id,
    Number(conversation.id),
    options.excludeRecipientId || null
  );
  if (protectionStatus === "sent") return "Reativação única já enviada anteriormente";
  if (["queued", "processing"].includes(protectionStatus)) return "Lead já está em uma campanha de reativação em andamento";
  if (protectionStatus === "uncertain") return "Envio anterior ficou sem confirmação; exige revisão manual para evitar duplicidade";
  if (options.requireEligible) {
    const matched = reactivation.matchingEligibilityLabels(conversation, REACTIVATION_CONFIG.eligibleLabels);
    if (!matched.length) return "Lead não possui uma das etiquetas elegíveis";
  }
  return null;
}

function reactivationSessionFromIntegration(integration) {
  return {
    organization_id: integration.id,
    chatwoot_base_url: integration.chatwootBaseUrl,
    chatwoot_account_id: integration.chatwootAccountId,
    chatwootToken: integration.chatwootToken,
  };
}

async function processNextReactivationRecipient() {
  if (!REACTIVATION_CONFIG.sendEnabled || reactivationWorkerBusy) return;
  reactivationWorkerBusy = true;
  let recipient = null;
  try {
    recipient = db.claimNextReactivationRecipient();
    if (!recipient) return;
    const integration = db.getOrganizationIntegration(recipient.organizationId);
    if (!integration) {
      db.markReactivationRecipientTerminal({
        recipientId: recipient.id,
        status: "failed",
        reason: "Organização não encontrada para envio",
      });
      return;
    }
    const workerSession = reactivationSessionFromIntegration(integration);
    const fetched = await fetchConversation(workerSession, recipient.conversationId);
    if (!fetched.conversation) {
      db.markReactivationRecipientTerminal({
        recipientId: recipient.id,
        status: "failed",
        reason: `Conversa indisponível no Chatwoot (HTTP ${fetched.response?.status || "?"})`,
      });
      return;
    }
    const protection = reactivationProtectionReason(workerSession, fetched.conversation, {
      requireEligible: false,
      excludeRecipientId: recipient.id,
    });
    if (protection) {
      db.markReactivationRecipientTerminal({ recipientId: recipient.id, status: "blocked", reason: protection });
      db.logAudit({
        organizationId: recipient.organizationId,
        action: "reactivation.recipient.blocked",
        entityType: "conversation",
        entityId: recipient.conversationId,
        metadata: { campaignId: recipient.campaignId, reason: protection },
      });
      return;
    }

    let sendResponse;
    try {
      sendResponse = await chatwootRequest(workerSession, {
        method: "POST",
        url: `${workerSession.chatwoot_base_url}/api/v1/accounts/${workerSession.chatwoot_account_id}/conversations/${recipient.conversationId}/messages`,
        data: {
          content: recipient.messageRendered,
          message_type: "outgoing",
          private: false,
          content_type: "text",
          content_attributes: {},
        },
      });
    } catch (error) {
      db.markReactivationRecipientTerminal({
        recipientId: recipient.id,
        status: "uncertain",
        reason: `Falha de transporte sem confirmação: ${String(error.message || "erro de rede").slice(0, 220)}`,
      });
      return;
    }

    if (sendResponse.status < 200 || sendResponse.status >= 300) {
      const ambiguous = sendResponse.status >= 500;
      db.markReactivationRecipientTerminal({
        recipientId: recipient.id,
        status: ambiguous ? "uncertain" : "failed",
        reason: ambiguous
          ? `Chatwoot retornou HTTP ${sendResponse.status}; resultado tratado como incerto para impedir reenvio automático`
          : `Chatwoot recusou o envio (HTTP ${sendResponse.status})`,
      });
      return;
    }

    const externalMessageId = sendResponse.data?.id || sendResponse.data?.data?.id || null;
    const sent = db.markReactivationRecipientSent({ recipientId: recipient.id, externalMessageId });
    db.logAudit({
      organizationId: recipient.organizationId,
      action: "reactivation.message.sent",
      entityType: "conversation",
      entityId: recipient.conversationId,
      metadata: {
        campaignId: recipient.campaignId,
        recipientId: recipient.id,
        externalMessageId: externalMessageId || undefined,
      },
    });

    try {
      const currentLabels = await readConversationLabels(workerSession, recipient.conversationId);
      const blockLabel = REACTIVATION_CONFIG.blockLabel;
      const nextLabels = [...currentLabels];
      if (!nextLabels.some((label) => reactivation.normalizeLabel(label) === blockLabel)) {
        nextLabels.push(blockLabel);
      }
      await writeConversationLabels(workerSession, recipient.conversationId, nextLabels);
    } catch (error) {
      db.logAudit({
        organizationId: recipient.organizationId,
        action: "reactivation.block_label.failed",
        entityType: "conversation",
        entityId: recipient.conversationId,
        metadata: {
          campaignId: recipient.campaignId,
          recipientId: recipient.id,
          sentAt: sent?.sentAt || null,
          error: String(error.message || "Falha ao aplicar etiqueta").slice(0, 240),
        },
      });
    }
  } catch (error) {
    console.error("Erro no worker de reativação:", error.message);
    if (recipient?.id) {
      db.markReactivationRecipientTerminal({
        recipientId: recipient.id,
        status: "uncertain",
        reason: `Erro inesperado durante processamento: ${String(error.message || "erro").slice(0, 220)}`,
      });
    }
  } finally {
    reactivationWorkerBusy = false;
  }
}

async function syncReactivationReplies(session, conversations = null) {
  const pending = db.listPendingReactivationReplyChecks(session.organization_id);
  if (!pending.length) return 0;

  // The Chatwoot conversation collection is enough for cards/labels, but it does not
  // reliably contain the message thread required to prove that the customer replied.
  // For pending reactivations, read the message endpoint of the exact conversation.
  const byId = Array.isArray(conversations)
    ? new Map(conversations.map((conversation) => [Number(conversation.id), conversation]))
    : new Map();

  let updated = 0;
  for (const recipient of pending) {
    const conversationId = Number(recipient.conversationId);
    let conversation = byId.get(conversationId) || { id: conversationId };

    try {
      const fetched = await fetchConversationMessages(session, conversationId);
      if (fetched.response.status < 200 || fetched.response.status >= 300) {
        db.logAudit({
          organizationId: session.organization_id,
          action: "reactivation.reply_sync.failed",
          entityType: "conversation",
          entityId: conversationId,
          metadata: {
            campaignId: recipient.campaignId,
            recipientId: recipient.id,
            httpStatus: fetched.response.status,
          },
        });
        continue;
      }
      conversation = { ...conversation, messages: fetched.messages };
    } catch (error) {
      db.logAudit({
        organizationId: session.organization_id,
        action: "reactivation.reply_sync.failed",
        entityType: "conversation",
        entityId: conversationId,
        metadata: {
          campaignId: recipient.campaignId,
          recipientId: recipient.id,
          error: String(error.message || "Falha ao consultar mensagens").slice(0, 240),
        },
      });
      continue;
    }

    const repliedAt = reactivation.latestIncomingAfter(conversation, recipient.sentAt);
    if (!repliedAt) continue;
    const changed = db.markReactivationReply({
      organizationId: session.organization_id,
      conversationId,
      repliedAt,
    });
    if (changed) {
      updated += changed;
      db.logAudit({
        organizationId: session.organization_id,
        action: "reactivation.customer.replied",
        entityType: "conversation",
        entityId: conversationId,
        metadata: { repliedAt },
      });
    }
  }
  return updated;
}

async function readConversationLabels(session, conversationId) {
  const response = await chatwootRequest(session, {
    method: "GET",
    url: `${session.chatwoot_base_url}/api/v1/accounts/${session.chatwoot_account_id}/conversations/${conversationId}/labels`,
  });
  if (response.status < 200 || response.status >= 300) {
    const error = new Error("Falha ao consultar etiquetas da conversa");
    error.status = response.status;
    error.response = response.data;
    throw error;
  }
  return extractLabelNames(response.data);
}

async function writeConversationLabels(session, conversationId, labels) {
  const response = await chatwootRequest(session, {
    method: "POST",
    url: `${session.chatwoot_base_url}/api/v1/accounts/${session.chatwoot_account_id}/conversations/${conversationId}/labels`,
    data: { labels: normalizeLabelNames(labels) },
  });
  if (response.status < 200 || response.status >= 300) {
    const error = new Error("Falha ao atualizar etiquetas da conversa");
    error.status = response.status;
    error.response = response.data;
    throw error;
  }
  const updated = extractLabelNames(response.data);
  return updated.length ? updated : normalizeLabelNames(labels);
}

async function assignConversation(session, conversationId, targetAgentId) {
  const response = await chatwootRequest(session, {
    method: "POST",
    url: `${session.chatwoot_base_url}/api/v1/accounts/${session.chatwoot_account_id}/conversations/${conversationId}/assignments`,
    data: { assignee_id: Number(targetAgentId) },
  });
  if (response.status < 200 || response.status >= 300) {
    const error = new Error("Falha ao transferir a oportunidade no Chatwoot");
    error.status = response.status;
    error.response = response.data;
    throw error;
  }
  return response.data;
}

async function writeConversationCustomAttributes(session, conversationId, customAttributes) {
  const response = await chatwootRequest(session, {
    method: "POST",
    url: `${session.chatwoot_base_url}/api/v1/accounts/${session.chatwoot_account_id}/conversations/${conversationId}/custom_attributes`,
    data: { custom_attributes: customAttributes },
  });
  if (response.status < 200 || response.status >= 300) {
    const error = new Error("Falha ao atualizar os dados comerciais da oportunidade");
    error.status = response.status;
    error.response = response.data;
    throw error;
  }
  return response.data;
}

function allowedHandoffTargets(session) {
  const role = String(session.operational_role || "agent");
  if (["admin", "manager"].includes(role)) return ["admin", "manager", "sdr", "seller", "agent"];
  if (role === "sdr") return ["seller", "manager", "admin"];
  if (role === "seller") return ["sdr", "manager", "admin"];
  return [];
}

function validateHandoffAction(session, action, targetUser) {
  const role = String(session.operational_role || "agent");
  if (["admin", "manager"].includes(role)) {
    if (action !== "transfer") throw Object.assign(new Error("Ação de encaminhamento inválida"), { status: 400 });
    return;
  }
  if (role === "sdr") {
    if (action === "to_seller" && targetUser?.operationalRole === "seller") return;
    if (action === "to_manager" && ["manager", "admin"].includes(targetUser?.operationalRole)) return;
    throw Object.assign(new Error("A SDR só pode encaminhar para vendedor ou gerente"), { status: 403 });
  }
  if (role === "seller") {
    if (action === "return_to_sdr" && targetUser?.operationalRole === "sdr") return;
    if (action === "to_manager" && ["manager", "admin"].includes(targetUser?.operationalRole)) return;
    throw Object.assign(new Error("O vendedor só pode devolver para SDR ou escalar para gerente"), { status: 403 });
  }
  throw Object.assign(new Error("Seu perfil não pode encaminhar oportunidades"), { status: 403 });
}

function normalizeStages(input) {
  if (!Array.isArray(input) || input.length < 3 || input.length > 50) {
    const error = new Error("Informe entre 3 e 50 etapas válidas");
    error.status = 400;
    throw error;
  }
  const result = [];
  const ids = new Set();
  for (const raw of input) {
    const id = String(raw?.id || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 42);
    const label = String(raw?.label || "").trim().slice(0, 60);
    const color = /^#[0-9a-f]{6}$/i.test(String(raw?.color || "")) ? raw.color : "#64748b";
    if (!id || !label || ids.has(id)) {
      const error = new Error("Existem etapas inválidas ou duplicadas");
      error.status = 400;
      throw error;
    }
    ids.add(id);
    result.push({
      id,
      label,
      color,
      archived: Boolean(raw?.archived),
      locked: Boolean(raw?.locked || ["new", "won", "lost"].includes(id)),
      terminal: Boolean(raw?.terminal || ["won", "lost"].includes(id)),
    });
  }
  for (const required of ["new", "won", "lost"]) {
    if (!ids.has(required)) {
      const error = new Error(`A etapa protegida ${required} não pode ser removida`);
      error.status = 400;
      throw error;
    }
  }
  return result;
}

function extractPayload(data) {
  return Array.isArray(data) ? data : data?.payload || data?.data?.payload || data?.data || [];
}

function pickCrmAttributes(attributes) {
  if (!attributes || typeof attributes !== "object") return {};
  return Object.fromEntries(
    Object.entries(attributes).filter(([key]) => String(key).startsWith("crm_"))
  );
}

function normalizeLabelNames(input) {
  if (!Array.isArray(input)) return [];
  const unique = new Map();
  for (const value of input.slice(0, 100)) {
    const label = String(value || "").trim().slice(0, 100);
    if (label) unique.set(label.toLocaleLowerCase("pt-BR"), label);
  }
  return [...unique.values()];
}

function extractLabelNames(data) {
  return normalizeLabelNames(extractPayload(data));
}

async function syncChatwootStageDefinition(session, values) {
  const listResponse = await chatwootRequest(session, {
    method: "GET",
    url: `${session.chatwoot_base_url}/api/v1/accounts/${session.chatwoot_account_id}/custom_attribute_definitions?attribute_model=0`,
  });
  if (listResponse.status < 200 || listResponse.status >= 300) {
    return { ok: false, status: listResponse.status, response: listResponse.data };
  }
  const stageDefinition = extractPayload(listResponse.data).find(
    (item) => item.attribute_key === "crm_stage"
  );
  if (!stageDefinition?.id) {
    return { ok: false, status: 404, response: { error: "Atributo crm_stage não encontrado" } };
  }
  const updateResponse = await chatwootRequest(session, {
    method: "PATCH",
    url: `${session.chatwoot_base_url}/api/v1/accounts/${session.chatwoot_account_id}/custom_attribute_definitions/${stageDefinition.id}`,
    data: {
      attribute_display_name: stageDefinition.attribute_display_name || "Etapa do CRM",
      attribute_display_type: stageDefinition.attribute_display_type ?? 6,
      attribute_description:
        stageDefinition.attribute_description || "Etapa comercial independente do status da conversa",
      attribute_key: "crm_stage",
      attribute_values: values,
      attribute_model: stageDefinition.attribute_model ?? 0,
    },
  });
  return {
    ok: updateResponse.status >= 200 && updateResponse.status < 300,
    status: updateResponse.status,
    response: updateResponse.data,
  };
}

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    app: "chatwoot-crm-kanban",
    version: "1.3.6.3-reactivation-manual-audit",
    database: "sqlite-central",
  });
});

function loginAttemptKey(req, email) {
  return `${req.ip}|${String(email || "").trim().toLowerCase()}`;
}

function isLoginBlocked(key) {
  const attempt = loginAttempts.get(key);
  if (!attempt) return false;
  if (Date.now() - attempt.startedAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return false;
  }
  return attempt.count >= LOGIN_MAX_ATTEMPTS;
}

function registerLoginFailure(key) {
  const current = loginAttempts.get(key);
  if (!current || Date.now() - current.startedAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, startedAt: Date.now() });
    return;
  }
  current.count += 1;
}

app.post("/api/session", async (req, res) => {
  const email = String(req.body?.email || "").trim();
  const password = String(req.body?.password || "");
  if (!email || !password) return res.status(400).json({ error: "Informe e-mail e senha" });
  const attemptKey = loginAttemptKey(req, email);
  if (isLoginBlocked(attemptKey)) {
    return res.status(429).json({ error: "Muitas tentativas. Aguarde alguns minutos e tente novamente." });
  }

  const user = db.authenticate(email, password);
  if (!user) {
    registerLoginFailure(attemptKey);
    return res.status(401).json({ error: "E-mail ou senha inválidos" });
  }
  loginAttempts.delete(attemptKey);

  const created = db.createSession(user, SESSION_TTL_MS);
  const session = db.getSession(created.rawToken);
  db.logAudit({
    organizationId: session.organization_id,
    actorUserId: session.user_id,
    action: "session.login",
    entityType: "session",
    metadata: { ip: req.ip, userAgent: String(req.headers["user-agent"] || "").slice(0, 240) },
  });
  db.touchPresence({
    organizationId: session.organization_id,
    userId: session.user_id,
    path: "/login",
    action: true,
  });
  res.setHeader("Set-Cookie", sessionCookie(created.rawToken, req));
  return res.json(db.sessionPayload(session));
});

app.get("/api/session", (req, res) => {
  const session = db.getSession(getRawSessionToken(req));
  if (!session) return res.json({ connected: false });
  return res.json(db.sessionPayload(session));
});

app.delete("/api/session", (req, res) => {
  const rawToken = getRawSessionToken(req);
  const session = db.getSession(rawToken);
  if (session) {
    db.logAudit({
      organizationId: session.organization_id,
      actorUserId: session.user_id,
      action: "session.logout",
      entityType: "session",
    });
  }
  db.deleteSession(rawToken);
  res.setHeader("Set-Cookie", clearSessionCookie(req));
  return res.status(204).send();
});

app.post("/api/crm/presence/heartbeat", requireSession, (req, res) => {
  const seenAt = db.touchPresence({
    organizationId: req.crmSession.organization_id,
    userId: req.crmSession.user_id,
    path: String(req.body?.view || req.path).slice(0, 120),
    action: Boolean(req.body?.action),
  });
  return res.json({ ok: true, seenAt });
});

app.get("/api/crm/presence", requireSession, requirePermission("presence:read"), (req, res) => {
  return res.json({ presence: db.listPresence(req.crmSession.organization_id) });
});

const CRM_ATTRIBUTE_DEFINITIONS = [
  {
    attribute_display_name: "Etapa do CRM",
    attribute_display_type: 6,
    attribute_description: "Etapa comercial independente do status da conversa",
    attribute_key: "crm_stage",
    attribute_values: [],
    attribute_model: 0,
  },
  {
    attribute_display_name: "Valor da oportunidade",
    attribute_display_type: 2,
    attribute_description: "Valor estimado da oportunidade",
    attribute_key: "crm_value",
    attribute_values: [],
    attribute_model: 0,
  },
  {
    attribute_display_name: "Próxima tarefa",
    attribute_display_type: 0,
    attribute_description: "Próxima ação comercial",
    attribute_key: "crm_next_task",
    attribute_values: [],
    attribute_model: 0,
  },
  {
    attribute_display_name: "Prazo da tarefa",
    attribute_display_type: 5,
    attribute_description: "Data prevista para a próxima ação",
    attribute_key: "crm_task_due_at",
    attribute_values: [],
    attribute_model: 0,
  },
  {
    attribute_display_name: "Tarefa concluída",
    attribute_display_type: 7,
    attribute_description: "Indica se a próxima tarefa foi concluída",
    attribute_key: "crm_task_done",
    attribute_values: [],
    attribute_model: 0,
  },
  {
    attribute_display_name: "Conclusão da tarefa",
    attribute_display_type: 0,
    attribute_description: "Data e hora em que a tarefa foi concluída",
    attribute_key: "crm_task_completed_at",
    attribute_values: [],
    attribute_model: 0,
  },
  {
    attribute_display_name: "Motivo da perda",
    attribute_display_type: 0,
    attribute_description: "Motivo informado ao marcar oportunidade como perdida",
    attribute_key: "crm_loss_reason",
    attribute_values: [],
    attribute_model: 0,
  },
  {
    attribute_display_name: "Data do desfecho CRM",
    attribute_display_type: 0,
    attribute_description: "Data e hora em que a oportunidade foi marcada como ganha ou perdida",
    attribute_key: "crm_outcome_at",
    attribute_values: [],
    attribute_model: 0,
  },
];

app.get("/api/crm/config", requireSession, (req, res) => {
  const session = req.crmSession;
  return res.json({
    ...db.sessionPayload(session),
    pipeline: db.getDefaultPipeline(session.organization_id),
    filterPresets: db.listFilterPresets(session.organization_id, session.user_id),
  });
});

function extractYoutubeVideoId(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;

  let parsed;
  try {
    parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch (_error) {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  let candidate = "";
  if (hostname === "youtu.be") {
    candidate = parsed.pathname.split("/").filter(Boolean)[0] || "";
  } else if (["youtube.com", "m.youtube.com", "music.youtube.com"].includes(hostname)) {
    if (parsed.pathname === "/watch") candidate = parsed.searchParams.get("v") || "";
    else {
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (["embed", "shorts", "live"].includes(parts[0])) candidate = parts[1] || "";
    }
  } else if (hostname === "youtube-nocookie.com") {
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] === "embed") candidate = parts[1] || "";
  }

  return /^[A-Za-z0-9_-]{11}$/.test(candidate) ? candidate : null;
}

function tutorialPayload(body = {}) {
  const youtubeVideoId = extractYoutubeVideoId(body.youtubeUrl || body.youtubeVideoId);
  if (!youtubeVideoId) {
    const error = new Error("Informe um link válido do YouTube");
    error.status = 400;
    throw error;
  }
  const title = String(body.title || "").trim().slice(0, 120);
  if (!title) {
    const error = new Error("Informe o título do vídeo");
    error.status = 400;
    throw error;
  }
  const description = String(body.description || "").trim().slice(0, 800);
  const category = String(body.category || "Geral").trim().slice(0, 60) || "Geral";
  const requestedOrder = Number(body.displayOrder);
  const displayOrder = Number.isInteger(requestedOrder)
    ? Math.max(-100000, Math.min(100000, requestedOrder))
    : 0;
  const active = body.active === undefined
    ? true
    : body.active === true || String(body.active).toLowerCase() === "true";
  return {
    youtubeVideoId,
    youtubeUrl: `https://www.youtube.com/watch?v=${youtubeVideoId}`,
    title,
    description,
    category,
    displayOrder,
    active,
  };
}

app.get("/api/crm/tutorials", requireSession, (req, res) => {
  const canManage = hasPermission(req.crmSession, "tutorials:manage");
  return res.json({
    tutorials: db.listTutorialVideos(req.crmSession.organization_id, {
      includeInactive: canManage,
    }),
    canManage,
  });
});

app.post(
  "/api/crm/tutorials",
  requireSession,
  requirePermission("tutorials:manage"),
  (req, res) => {
    try {
      const payload = tutorialPayload(req.body);
      const tutorial = db.createTutorialVideo({
        organizationId: req.crmSession.organization_id,
        actorUserId: req.crmSession.user_id,
        ...payload,
      });
      return res.status(201).json({ tutorial });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || "Falha ao cadastrar tutorial" });
    }
  }
);

app.patch(
  "/api/crm/tutorials/:id",
  requireSession,
  requirePermission("tutorials:manage"),
  (req, res) => {
    try {
      const payload = tutorialPayload(req.body);
      const tutorial = db.updateTutorialVideo({
        organizationId: req.crmSession.organization_id,
        actorUserId: req.crmSession.user_id,
        tutorialId: req.params.id,
        ...payload,
      });
      if (!tutorial) return res.status(404).json({ error: "Tutorial não encontrado" });
      return res.json({ tutorial });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || "Falha ao atualizar tutorial" });
    }
  }
);

app.delete(
  "/api/crm/tutorials/:id",
  requireSession,
  requirePermission("tutorials:manage"),
  (req, res) => {
    const deleted = db.deleteTutorialVideo({
      organizationId: req.crmSession.organization_id,
      actorUserId: req.crmSession.user_id,
      tutorialId: req.params.id,
    });
    if (!deleted) return res.status(404).json({ error: "Tutorial não encontrado" });
    return res.status(204).send();
  }
);


app.get(
  "/api/crm/reactivations/candidates",
  requireSession,
  requirePermission("reactivations:manage"),
  async (req, res) => {
    try {
      const requestedLabels = String(req.query.labels || "")
        .split(",")
        .map(reactivation.normalizeLabel)
        .filter((label) => REACTIVATION_CONFIG.eligibleLabels.includes(label));
      const selectedLabels = requestedLabels.length
        ? [...new Set(requestedLabels)]
        : [...REACTIVATION_CONFIG.eligibleLabels];
      const period = ["today", "3d", "7d", "14d", "30d", "all"].includes(String(req.query.period || ""))
        ? String(req.query.period)
        : "7d";
      const search = String(req.query.search || "").trim().toLocaleLowerCase("pt-BR").slice(0, 120);
      const conversations = await fetchScopedActiveConversations(req.crmSession);
      const matched = [];
      for (const conversation of conversations) {
        if (!reactivation.matchesPeriod(conversation, period)) continue;
        const snapshot = reactivation.candidateSnapshot(conversation, REACTIVATION_CONFIG, { selectedLabels });
        if (!snapshot.matchedLabels.length) continue;
        if (search) {
          const haystack = [
            snapshot.contactName,
            snapshot.phone,
            snapshot.email,
            String(snapshot.conversationId),
          ].join(" ").toLocaleLowerCase("pt-BR");
          if (!haystack.includes(search)) continue;
        }
        const blockReason = reactivationProtectionReason(req.crmSession, conversation, { requireEligible: true });
        matched.push({
          ...snapshot,
          eligible: !blockReason,
          blockReason,
        });
      }
      matched.sort((a, b) => String(b.lastActivityAt || "").localeCompare(String(a.lastActivityAt || "")));
      const eligible = matched.filter((item) => item.eligible);
      return res.json({
        configuration: {
          sendEnabled: REACTIVATION_CONFIG.sendEnabled,
          eligibleLabels: REACTIVATION_CONFIG.eligibleLabels,
          blockLabel: REACTIVATION_CONFIG.blockLabel,
          maxRecipients: REACTIVATION_CONFIG.maxRecipients,
          workerIntervalMs: REACTIVATION_CONFIG.intervalMs,
          templates: REACTIVATION_CONFIG.templates,
          organizationName: req.crmSession.organization_name,
        },
        period,
        selectedLabels,
        matchedCount: matched.length,
        eligibleCount: eligible.length,
        blockedCount: matched.length - eligible.length,
        candidates: matched,
      });
    } catch (error) {
      console.error("Erro ao carregar candidatos à reativação:", error.message);
      return res.status(error.status || 502).json({
        error: error.message || "Falha ao carregar candidatos à reativação",
      });
    }
  }
);

app.get(
  "/api/crm/reactivations/campaigns",
  requireSession,
  requirePermission("reactivations:manage"),
  async (req, res) => {
    try {
      if (String(req.query.sync || "1") !== "0") {
        await syncReactivationReplies(req.crmSession);
      }
      return res.json({
        summary: db.reactivationSummary(req.crmSession.organization_id),
        campaigns: db.listReactivationCampaigns(
          req.crmSession.organization_id,
          Number(req.query.limit || 30)
        ),
      });
    } catch (error) {
      console.error("Erro ao carregar histórico de reativação:", error.message);
      return res.status(error.status || 502).json({
        error: error.message || "Falha ao carregar histórico de reativação",
      });
    }
  }
);

app.get(
  "/api/crm/reactivations/campaigns/:id/recipients",
  requireSession,
  requirePermission("reactivations:manage"),
  (req, res) => {
    const campaign = db.getReactivationCampaign(req.crmSession.organization_id, req.params.id);
    if (!campaign) return res.status(404).json({ error: "Campanha de reativação não encontrada" });
    return res.json({
      campaign,
      recipients: db.listReactivationRecipients(req.crmSession.organization_id, req.params.id),
    });
  }
);

app.post(
  "/api/crm/reactivations/campaigns",
  requireSession,
  requirePermission("reactivations:manage"),
  async (req, res) => {
    if (!hasPermission(req.crmSession, "messages:send")) {
      return res.status(403).json({ error: "Seu perfil não possui permissão para enviar mensagens" });
    }
    if (!REACTIVATION_CONFIG.sendEnabled) {
      return res.status(409).json({
        error: "O envio de reativação está desativado. Ative REACTIVATION_SEND_ENABLED após validar a implantação.",
      });
    }
    try {
      const messageTemplate = reactivation.validateMessageTemplate(req.body?.messageTemplate);
      const templateKey = String(req.body?.templateKey || "custom").trim().slice(0, 60) || "custom";
      const name = String(req.body?.name || "Reativação manual").trim().slice(0, 120) || "Reativação manual";
      const rawRecipients = Array.isArray(req.body?.recipients) ? req.body.recipients : [];
      const unique = new Map();
      for (const raw of rawRecipients) {
        const conversationId = Number(raw?.conversationId);
        if (!Number.isInteger(conversationId) || conversationId <= 0) continue;
        if (!unique.has(conversationId)) {
          const sourceType = raw?.sourceType === "manual" ? "manual" : "tag";
          unique.set(conversationId, {
            conversationId,
            sourceType,
            sourceReason: sourceType === "manual"
              ? reactivation.validateManualSourceReason(raw?.sourceReason)
              : null,
          });
        }
      }
      const selections = [...unique.values()];
      if (!selections.length) return res.status(400).json({ error: "Selecione pelo menos um lead" });
      if (selections.length > REACTIVATION_CONFIG.maxRecipients) {
        return res.status(400).json({
          error: `Selecione no máximo ${REACTIVATION_CONFIG.maxRecipients} leads por campanha`,
        });
      }

      const conversations = await fetchScopedActiveConversations(req.crmSession);
      const byId = new Map(conversations.map((conversation) => [Number(conversation.id), conversation]));
      const recipients = [];
      for (const selection of selections) {
        const conversation = byId.get(selection.conversationId);
        if (!conversation) {
          recipients.push({
            conversationId: selection.conversationId,
            contactName: `Conversa #${selection.conversationId}`,
            phone: "",
            sourceType: selection.sourceType,
            sourceReason: selection.sourceReason || null,
            sourceLabels: [],
            messageRendered: messageTemplate.replace(/{{\s*primeiro_nome\s*}}/g, "tudo bem"),
            status: "blocked",
            blockReason: "Conversa não encontrada no escopo operacional atual",
          });
          continue;
        }
        const snapshot = reactivation.candidateSnapshot(conversation, REACTIVATION_CONFIG);
        let blockReason = reactivationProtectionReason(req.crmSession, conversation, {
          requireEligible: selection.sourceType !== "manual",
        });
        if (!blockReason && selection.sourceType !== "manual" && !snapshot.matchedLabels.length) {
          blockReason = "Lead não possui uma das etiquetas elegíveis";
        }
        recipients.push({
          conversationId: snapshot.conversationId,
          contactId: snapshot.contactId,
          contactName: snapshot.contactName,
          phone: snapshot.phone,
          sourceType: selection.sourceType,
          sourceReason: selection.sourceReason || null,
          sourceLabels: snapshot.matchedLabels,
          messageRendered: reactivation.renderMessage(messageTemplate, conversation),
          status: blockReason ? "blocked" : "queued",
          blockReason,
        });
      }

      const campaign = db.createReactivationCampaign({
        organizationId: req.crmSession.organization_id,
        actorUserId: req.crmSession.user_id,
        name,
        templateKey,
        messageTemplate,
        recipients,
      });
      return res.status(201).json({
        campaign,
        queued: recipients.filter((item) => item.status === "queued").length,
        blocked: recipients
          .filter((item) => item.status === "blocked")
          .map((item) => ({ conversationId: item.conversationId, reason: item.blockReason })),
      });
    } catch (error) {
      return res.status(error.status || 500).json({
        error: error.message || "Falha ao criar campanha de reativação",
      });
    }
  }
);

app.post(
  "/api/crm/reactivations/campaigns/:id/cancel",
  requireSession,
  requirePermission("reactivations:manage"),
  (req, res) => {
    const campaign = db.cancelReactivationCampaign({
      organizationId: req.crmSession.organization_id,
      campaignId: req.params.id,
      actorUserId: req.crmSession.user_id,
    });
    if (!campaign) return res.status(404).json({ error: "Campanha de reativação não encontrada" });
    return res.json({ campaign });
  }
);

app.get("/api/crm/workspace/conversations", requireSession, async (req, res) => {
  try {
    const allConversations = await fetchAllChatwootConversations(req.crmSession);
    db.syncInterventions({
      organizationId: req.crmSession.organization_id,
      conversations: allConversations,
    });
    const scopedConversations = access
      .filterConversationsForSession(req.crmSession, allConversations);
    const archivedItems = db.listArchivedOpportunities(req.crmSession.organization_id);
    const archivedByConversation = new Map(
      archivedItems.map((item) => [Number(item.conversationId), item])
    );
    const archivedContactKeys = suppression.archivedContactKeys(
      allConversations,
      archivedItems
    );
    const activeConversations = scopedConversations.filter((conversation) => {
      if (archivedByConversation.has(Number(conversation.id))) return false;
      const contactKey = suppression.contactIdentity(conversation);
      return !contactKey || !archivedContactKeys.has(contactKey);
    });
    const canViewArchive = hasPermission(req.crmSession, "archive:manage");
    const archivedConversations = canViewArchive
      ? scopedConversations
          .filter((conversation) => archivedByConversation.has(Number(conversation.id)))
          .map((conversation) => ({
            ...conversation,
            crm_archive: archivedByConversation.get(Number(conversation.id)),
          }))
      : [];
    const sortedConversations = access.sortOperationalQueue(activeConversations);
    return res.json({
      conversations: sortedConversations,
      archivedConversations,
      archivedCount: archivedConversations.length,
      totalVisible: sortedConversations.length,
      totalOrganization: allConversations.length,
      interventionCount: sortedConversations.filter(access.isInterventionConversation).length,
      scope: req.crmSession.visibility_scope,
      linkedAgentId: req.crmSession.chatwoot_agent_id
        ? Number(req.crmSession.chatwoot_agent_id)
        : null,
    });
  } catch (error) {
    console.error("Erro ao carregar escopo operacional:", error.message);
    return res.status(error.status || 502).json({
      error: error.message || "Falha ao carregar as conversas do escopo operacional",
      details: error.response || undefined,
    });
  }
});

app.post(
  "/api/crm/bootstrap",
  requireSession,
  requirePermission("pipeline:manage"),
  async (req, res) => {
    const session = req.crmSession;
    const listUrl = `${session.chatwoot_base_url}/api/v1/accounts/${session.chatwoot_account_id}/custom_attribute_definitions?attribute_model=0`;
    try {
      const currentResponse = await chatwootRequest(session, { method: "GET", url: listUrl });
      if (currentResponse.status < 200 || currentResponse.status >= 300) {
        return relayAxiosResponse(res, currentResponse);
      }
      const current = extractPayload(currentResponse.data);
      const existingKeys = new Set(current.map((item) => item.attribute_key));
      const stages = db.getDefaultPipeline(session.organization_id).stages;
      const created = [];
      const skipped = [];
      const errors = [];
      for (const definition of CRM_ATTRIBUTE_DEFINITIONS) {
        if (existingKeys.has(definition.attribute_key)) {
          skipped.push(definition.attribute_key);
          continue;
        }
        const payload = definition.attribute_key === "crm_stage"
          ? { ...definition, attribute_values: stages.map((stage) => stage.id) }
          : definition;
        const createResponse = await chatwootRequest(session, {
          method: "POST",
          url: `${session.chatwoot_base_url}/api/v1/accounts/${session.chatwoot_account_id}/custom_attribute_definitions`,
          data: payload,
        });
        if (createResponse.status >= 200 && createResponse.status < 300) created.push(definition.attribute_key);
        else errors.push({ key: definition.attribute_key, status: createResponse.status, response: createResponse.data });
      }
      const stageSync = await syncChatwootStageDefinition(
        session,
        stages.map((stage) => stage.id)
      );
      db.logAudit({
        organizationId: session.organization_id,
        actorUserId: session.user_id,
        action: "crm.bootstrap",
        entityType: "chatwoot_configuration",
        after: { created, skipped, errorCount: errors.length, stageSync: stageSync.ok },
      });
      return res.status(errors.length || !stageSync.ok ? 207 : 200).json({
        configured: errors.length === 0 && stageSync.ok,
        created,
        skipped,
        errors,
        stageSync,
      });
    } catch (error) {
      console.error("Erro ao inicializar atributos CRM:", error.message);
      return res.status(502).json({ error: "Falha ao configurar os atributos do CRM" });
    }
  }
);

app.post(
  "/api/crm/stages/save",
  requireSession,
  requirePermission("pipeline:manage"),
  async (req, res) => {
    try {
      const stages = normalizeStages(req.body?.stages);
      const saved = db.replacePipelineStages(
        req.crmSession.organization_id,
        stages,
        req.crmSession.user_id
      );
      const stageSync = await syncChatwootStageDefinition(
        req.crmSession,
        saved.map((stage) => stage.id)
      );
      return res.status(stageSync.ok ? 200 : 207).json({ stages: saved, stageSync });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || "Falha ao salvar etapas" });
    }
  }
);

app.post("/api/crm/stages/sync", requireSession, requirePermission("pipeline:manage"), async (req, res) => {
  const stages = db.getDefaultPipeline(req.crmSession.organization_id).stages;
  const result = await syncChatwootStageDefinition(req.crmSession, stages.map((stage) => stage.id));
  return res.status(result.ok ? 200 : result.status || 502).json(result);
});

app.post("/api/crm/filters", requireSession, (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 60);
  const scope = req.body?.scope === "shared" ? "shared" : "personal";
  const snapshot = req.body?.snapshot;
  if (!name || !snapshot || typeof snapshot !== "object") {
    return res.status(400).json({ error: "Informe nome e conteúdo do filtro" });
  }
  if (scope === "shared" && !hasPermission(req.crmSession, "filters:share")) {
    return res.status(403).json({ error: "Seu perfil não pode criar filtros compartilhados" });
  }
  const preset = db.createFilterPreset({
    organizationId: req.crmSession.organization_id,
    userId: req.crmSession.user_id,
    name,
    scope,
    snapshot,
  });
  return res.status(201).json({ preset });
});

app.delete("/api/crm/filters/:id", requireSession, (req, res) => {
  try {
    const deleted = db.deleteFilterPreset({
      organizationId: req.crmSession.organization_id,
      userId: req.crmSession.user_id,
      filterId: req.params.id,
      canManageShared: hasPermission(req.crmSession, "filters:share"),
    });
    if (!deleted) return res.status(404).json({ error: "Filtro não encontrado" });
    return res.status(204).send();
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
});

app.get("/api/crm/users", requireSession, requirePermission("users:manage"), (req, res) => {
  return res.json({ users: db.listUsers(req.crmSession.organization_id) });
});

app.post("/api/crm/users", requireSession, requirePermission("users:manage"), (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 80);
  const email = String(req.body?.email || "").trim();
  const password = String(req.body?.password || "");
  const operationalRole = ["admin", "manager", "sdr", "seller", "agent", "viewer"].includes(req.body?.operationalRole)
    ? req.body.operationalRole
    : "sdr";
  const visibilityScope = ["all", "mine", "unassigned_and_mine", "unassigned"].includes(req.body?.visibilityScope)
    ? req.body.visibilityScope
    : undefined;
  const chatwootAgentId = req.body?.chatwootAgentId ? Number(req.body.chatwootAgentId) : null;
  if (!name || !email || password.length < 10) {
    return res.status(400).json({ error: "Informe nome, e-mail e senha com pelo menos 10 caracteres" });
  }
  try {
    const user = db.createUser({
      organizationId: req.crmSession.organization_id,
      actorUserId: req.crmSession.user_id,
      name,
      email,
      password,
      operationalRole,
      chatwootAgentId,
      visibilityScope,
    });
    return res.status(201).json({ user });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
});

app.patch("/api/crm/users/:id", requireSession, requirePermission("users:manage"), (req, res) => {
  if (req.params.id === req.crmSession.user_id && req.body?.active === false) {
    return res.status(400).json({ error: "Você não pode desativar seu próprio usuário" });
  }
  const operationalRole = req.body?.operationalRole &&
    ["admin", "manager", "sdr", "seller", "agent", "viewer"].includes(req.body.operationalRole)
    ? req.body.operationalRole
    : undefined;
  const visibilityScope = req.body?.visibilityScope &&
    ["all", "mine", "unassigned_and_mine", "unassigned"].includes(req.body.visibilityScope)
    ? req.body.visibilityScope
    : undefined;
  const password = req.body?.password ? String(req.body.password) : undefined;
  if (password && password.length < 10) {
    return res.status(400).json({ error: "A nova senha deve possuir pelo menos 10 caracteres" });
  }
  try {
    const user = db.updateUser({
      organizationId: req.crmSession.organization_id,
      actorUserId: req.crmSession.user_id,
      userId: req.params.id,
      name: req.body?.name ? String(req.body.name).trim().slice(0, 80) : undefined,
      operationalRole,
      chatwootAgentId: req.body?.chatwootAgentId === undefined
        ? undefined
        : req.body.chatwootAgentId,
      visibilityScope,
      active: typeof req.body?.active === "boolean" ? req.body.active : undefined,
      password,
    });
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
    return res.json({ user });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
});

app.get("/api/crm/audit", requireSession, requirePermission("audit:read"), (req, res) => {
  return res.json({ audit: db.listAudit(req.crmSession.organization_id, req.query.limit) });
});

app.get("/api/crm/handoff/targets", requireSession, (req, res) => {
  const roles = allowedHandoffTargets(req.crmSession);
  const actorRole = String(req.crmSession.operational_role || "agent");
  const targets = db.listOperationalUsers(req.crmSession.organization_id, { roles })
    .filter((user) => ["admin", "manager"].includes(actorRole) || user.id !== req.crmSession.user_id)
    .map((user) => ({
      id: user.id,
      name: user.name,
      operationalRole: user.operationalRole,
      chatwootAgentId: user.chatwootAgentId,
    }));
  return res.json({ targets });
});

app.post("/api/crm/opportunities/:conversationId/handoff", requireSession, async (req, res) => {
  const conversationId = Number(req.params.conversationId);
  const action = String(req.body?.action || "").trim();
  const reason = String(req.body?.reason || "").trim().slice(0, 500);
  const targetAgentId = Number(req.body?.targetAgentId || 0);
  if (!Number.isInteger(conversationId) || conversationId <= 0 || !action || reason.length < 3) {
    return res.status(400).json({ error: "Informe a ação e o motivo do encaminhamento" });
  }

  try {
    const conversation = await requireConversationAccess(req, res, conversationId);
    if (!conversation) return;
    const currentAgentId = access.extractAssigneeId(conversation);
    const actorRole = String(req.crmSession.operational_role || "agent");

    if (actorRole === "seller" && action === "request_redistribution") {
      const request = db.createTransferRequest({
        organizationId: req.crmSession.organization_id,
        conversationId,
        requestedByUserId: req.crmSession.user_id,
        reason,
        previousAgentId: currentAgentId,
      });
      return res.status(201).json({ requested: true, request });
    }

    const targetUser = db.getOperationalUserByAgentId(
      req.crmSession.organization_id,
      targetAgentId
    );
    if (!targetUser) {
      return res.status(400).json({ error: "Selecione um responsável válido e ativo" });
    }
    validateHandoffAction(req.crmSession, action, targetUser);

    const attributes = conversation.custom_attributes || {};
    const stageBefore = String(attributes.crm_stage || "new");
    let stageAfter = stageBefore;
    if (action === "to_seller" && targetUser.operationalRole === "seller") {
      stageAfter = "proposal";
    } else if (action === "return_to_sdr" && targetUser.operationalRole === "sdr") {
      stageAfter = "qualification";
    }

    await assignConversation(req.crmSession, conversationId, targetAgentId);
    if (stageAfter !== stageBefore) {
      await writeConversationCustomAttributes(req.crmSession, conversationId, {
        ...attributes,
        crm_stage: stageAfter,
        crm_outcome_at: null,
      });
    }

    db.logDirectHandoff({
      organizationId: req.crmSession.organization_id,
      actorUserId: req.crmSession.user_id,
      conversationId,
      action,
      reason,
      previousAgentId: currentAgentId,
      targetAgentId,
      stageBefore,
      stageAfter,
    });

    return res.json({
      transferred: true,
      action,
      reason,
      previousAgentId: currentAgentId,
      targetAgentId,
      targetUser: {
        name: targetUser.name,
        operationalRole: targetUser.operationalRole,
      },
      stageBefore,
      stageAfter,
    });
  } catch (error) {
    console.error("Erro no encaminhamento controlado:", error.message);
    return res.status(error.status || 502).json({
      error: error.message || "Falha ao encaminhar a oportunidade",
      details: error.response || undefined,
    });
  }
});

app.get(
  "/api/crm/transfer-requests",
  requireSession,
  requirePermission("transfer_requests:manage"),
  (req, res) => {
    return res.json({
      requests: db.listTransferRequests(
        req.crmSession.organization_id,
        String(req.query.status || "pending")
      ),
    });
  }
);

app.post(
  "/api/crm/transfer-requests/:id/resolve",
  requireSession,
  requirePermission("transfer_requests:manage"),
  async (req, res) => {
    const decision = req.body?.decision === "approved" ? "approved" : "rejected";
    const targetAgentId = Number(req.body?.targetAgentId || 0);
    const resolutionNote = String(req.body?.resolutionNote || "").trim().slice(0, 500);
    try {
      const request = db.getTransferRequest(req.crmSession.organization_id, req.params.id);
      if (!request) return res.status(404).json({ error: "Solicitação não encontrada" });
      if (decision === "approved") {
        const targetUser = db.getOperationalUserByAgentId(
          req.crmSession.organization_id,
          targetAgentId
        );
        if (!targetUser) {
          return res.status(400).json({ error: "Selecione um responsável válido" });
        }
        const fetched = await fetchConversation(req.crmSession, request.conversationId);
        if (!fetched.conversation) return relayAxiosResponse(res, fetched.response);
        await assignConversation(req.crmSession, request.conversationId, targetAgentId);
        const attributes = fetched.conversation.custom_attributes || {};
        const stageBefore = String(attributes.crm_stage || "new");
        let stageAfter = stageBefore;
        if (targetUser.operationalRole === "seller" && ["new", "contacted", "qualification"].includes(stageBefore)) {
          stageAfter = "proposal";
        } else if (targetUser.operationalRole === "sdr" && ["proposal", "negotiation"].includes(stageBefore)) {
          stageAfter = "qualification";
        }
        if (stageAfter !== stageBefore) {
          await writeConversationCustomAttributes(req.crmSession, request.conversationId, {
            ...attributes,
            crm_stage: stageAfter,
            crm_outcome_at: null,
          });
        }
        db.logDirectHandoff({
          organizationId: req.crmSession.organization_id,
          actorUserId: req.crmSession.user_id,
          conversationId: request.conversationId,
          action: "redistribution_approved",
          reason: request.reason,
          previousAgentId: request.previousAgentId,
          targetAgentId,
          stageBefore,
          stageAfter,
        });
      }
      const resolved = db.resolveTransferRequest({
        organizationId: req.crmSession.organization_id,
        requestId: req.params.id,
        actorUserId: req.crmSession.user_id,
        status: decision,
        targetAgentId: decision === "approved" ? targetAgentId : null,
        resolutionNote,
      });
      return res.json({ request: resolved });
    } catch (error) {
      console.error("Erro ao resolver redistribuição:", error.message);
      return res.status(error.status || 502).json({
        error: error.message || "Falha ao resolver a redistribuição",
        details: error.response || undefined,
      });
    }
  }
);

app.post(
  "/api/crm/opportunities/:conversationId/archive",
  requireSession,
  requirePermission("archive:manage"),
  async (req, res) => {
    const conversationId = Number(req.params.conversationId);
    const reason = String(req.body?.reason || "").trim();
    const note = String(req.body?.note || "").trim();
    if (!Number.isInteger(conversationId) || conversationId <= 0 || !reason) {
      return res.status(400).json({ error: "Informe a conversa e o motivo do arquivamento" });
    }
    if (reason === "Outro" && note.length < 3) {
      return res.status(400).json({ error: "Descreva o motivo do arquivamento" });
    }
    try {
      const conversation = await requireConversationAccess(req, res, conversationId);
      if (!conversation) return;
      const requestedScope = String(req.body?.scope || "conversation").trim().toLowerCase();
      const archiveScope = requestedScope === "contact" ? "contact" : "conversation";
      const contactKey = archiveScope === "contact"
        ? suppression.contactIdentity(conversation)
        : "";
      const archived = db.archiveOpportunity({
        organizationId: req.crmSession.organization_id,
        conversationId,
        actorUserId: req.crmSession.user_id,
        reason,
        note,
        archiveScope,
        contactKey,
      });
      return res.json({ archived });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || "Falha ao arquivar" });
    }
  }
);

app.post(
  "/api/crm/opportunities/:conversationId/restore",
  requireSession,
  requirePermission("archive:manage"),
  (req, res) => {
    const conversationId = Number(req.params.conversationId);
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      return res.status(400).json({ error: "Conversa inválida" });
    }
    const restored = db.restoreOpportunity({
      organizationId: req.crmSession.organization_id,
      conversationId,
      actorUserId: req.crmSession.user_id,
    });
    if (!restored) return res.status(404).json({ error: "Oportunidade arquivada não encontrada" });
    return res.json({ restored });
  }
);

app.post(
  "/api/crm/opportunities/:conversationId/labels",
  requireSession,
  requirePermission("opportunities:write"),
  async (req, res) => {
    const conversationId = Number(req.params.conversationId);
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      return res.status(400).json({ error: "Conversa inválida" });
    }

    const requestedAdd = normalizeLabelNames(req.body?.add);
    const requestedRemove = normalizeLabelNames(req.body?.remove);
    if (requestedAdd.length + requestedRemove.length > 100) {
      return res.status(400).json({ error: "Quantidade de etiquetas inválida" });
    }

    try {
      const allowedConversation = await requireConversationAccess(req, res, conversationId);
      if (!allowedConversation) return;
      const [availableResponse, currentResponse] = await Promise.all([
        chatwootRequest(req.crmSession, {
          method: "GET",
          url: `${req.crmSession.chatwoot_base_url}/api/v1/accounts/${req.crmSession.chatwoot_account_id}/labels`,
        }),
        chatwootRequest(req.crmSession, {
          method: "GET",
          url: `${req.crmSession.chatwoot_base_url}/api/v1/accounts/${req.crmSession.chatwoot_account_id}/conversations/${conversationId}/labels`,
        }),
      ]);

      if (availableResponse.status < 200 || availableResponse.status >= 300) {
        return relayAxiosResponse(res, availableResponse);
      }
      if (currentResponse.status < 200 || currentResponse.status >= 300) {
        return relayAxiosResponse(res, currentResponse);
      }

      const availablePayload = extractPayload(availableResponse.data);
      const availableDefinitions = Array.isArray(availablePayload) ? availablePayload : [];
      const availableByKey = new Map(
        availableDefinitions
          .map((definition) => String(definition?.title || definition?.name || "").trim())
          .filter(Boolean)
          .map((title) => [title.toLocaleLowerCase("pt-BR"), title])
      );
      const invalidAdditions = requestedAdd.filter(
        (label) => !availableByKey.has(label.toLocaleLowerCase("pt-BR"))
      );
      if (invalidAdditions.length) {
        return res.status(400).json({
          error: `Etiqueta não cadastrada no Chatwoot: ${invalidAdditions.join(", ")}`,
        });
      }

      const before = extractLabelNames(currentResponse.data);
      const removeKeys = new Set(
        requestedRemove.map((label) => label.toLocaleLowerCase("pt-BR"))
      );
      const next = before.filter(
        (label) => !removeKeys.has(label.toLocaleLowerCase("pt-BR"))
      );
      const nextKeys = new Set(next.map((label) => label.toLocaleLowerCase("pt-BR")));
      for (const label of requestedAdd) {
        const canonical = availableByKey.get(label.toLocaleLowerCase("pt-BR"));
        const key = canonical.toLocaleLowerCase("pt-BR");
        if (!nextKeys.has(key)) {
          next.push(canonical);
          nextKeys.add(key);
        }
      }

      const updateResponse = await chatwootRequest(req.crmSession, {
        method: "POST",
        url: `${req.crmSession.chatwoot_base_url}/api/v1/accounts/${req.crmSession.chatwoot_account_id}/conversations/${conversationId}/labels`,
        data: { labels: next },
      });
      if (updateResponse.status < 200 || updateResponse.status >= 300) {
        return relayAxiosResponse(res, updateResponse);
      }

      const after = extractLabelNames(updateResponse.data);
      db.logAudit({
        organizationId: req.crmSession.organization_id,
        actorUserId: req.crmSession.user_id,
        action: "conversation.labels.updated",
        entityType: "conversation",
        entityId: conversationId,
        before: { labels: before },
        after: { labels: after.length ? after : next },
        metadata: {
          added: requestedAdd,
          removed: requestedRemove,
        },
      });

      return res.json({ labels: after.length ? after : next });
    } catch (error) {
      console.error("Erro ao atualizar etiquetas da conversa:", error.message);
      return res.status(502).json({ error: "Falha ao atualizar as etiquetas no Chatwoot" });
    }
  }
);

app.post(
  "/api/crm/interventions/:conversationId/assume",
  requireSession,
  requirePermission("interventions:manage"),
  async (req, res) => {
    const conversationId = Number(req.params.conversationId);
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      return res.status(400).json({ error: "Conversa inválida" });
    }
    const linkedAgentId = Number(req.crmSession.chatwoot_agent_id || 0);
    if (!linkedAgentId) {
      return res.status(400).json({
        error: "Seu usuário ainda não está vinculado a um agente do Chatwoot",
      });
    }
    try {
      const conversation = await requireConversationAccess(req, res, conversationId);
      if (!conversation) return;
      const assignmentResponse = await chatwootRequest(req.crmSession, {
        method: "POST",
        url: `${req.crmSession.chatwoot_base_url}/api/v1/accounts/${req.crmSession.chatwoot_account_id}/conversations/${conversationId}/assignments`,
        data: { assignee_id: linkedAgentId },
      });
      if (assignmentResponse.status < 200 || assignmentResponse.status >= 300) {
        return relayAxiosResponse(res, assignmentResponse);
      }
      const before = await readConversationLabels(req.crmSession, conversationId);
      const next = before.filter(
        (label) => String(label).toLocaleLowerCase("pt-BR") !== "precisa-humano"
      );
      if (!next.some((label) => String(label).toLocaleLowerCase("pt-BR") === "atendimento-manual")) {
        next.push("atendimento-manual");
      }
      const labels = await writeConversationLabels(req.crmSession, conversationId, next);
      db.markInterventionAssumed({
        organizationId: req.crmSession.organization_id,
        conversationId,
        actorUserId: req.crmSession.user_id,
        agentId: linkedAgentId,
        labels,
      });
      return res.json({ assumed: true, assigneeId: linkedAgentId, labels });
    } catch (error) {
      console.error("Erro ao assumir intervenção:", error.message);
      return res.status(error.status || 502).json({
        error: error.message || "Falha ao assumir a intervenção",
        details: error.response || undefined,
      });
    }
  }
);

app.post(
  "/api/crm/interventions/:conversationId/resolve",
  requireSession,
  requirePermission("interventions:manage"),
  async (req, res) => {
    const conversationId = Number(req.params.conversationId);
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      return res.status(400).json({ error: "Conversa inválida" });
    }
    try {
      const conversation = await requireConversationAccess(req, res, conversationId);
      if (!conversation) return;
      const before = await readConversationLabels(req.crmSession, conversationId);
      const blocking = new Set(["precisa-humano", "atendimento-manual"]);
      const next = before.filter(
        (label) => !blocking.has(String(label).toLocaleLowerCase("pt-BR"))
      );
      const labels = await writeConversationLabels(req.crmSession, conversationId, next);
      db.markInterventionResolved({
        organizationId: req.crmSession.organization_id,
        conversationId,
        actorUserId: req.crmSession.user_id,
      });
      return res.json({ resolved: true, labels });
    } catch (error) {
      console.error("Erro ao resolver intervenção:", error.message);
      return res.status(error.status || 502).json({
        error: error.message || "Falha ao resolver a intervenção",
        details: error.response || undefined,
      });
    }
  }
);

app.post(
  "/api/crm/opportunities/:conversationId/custom-attributes",
  requireSession,
  requirePermission("opportunities:write"),
  async (req, res) => {
    const conversationId = Number(req.params.conversationId);
    const customAttributes = req.body?.custom_attributes;
    if (!Number.isInteger(conversationId) || conversationId <= 0 || !customAttributes || typeof customAttributes !== "object") {
      return res.status(400).json({ error: "Conversa ou atributos inválidos" });
    }
    try {
      const allowedConversation = await requireConversationAccess(req, res, conversationId);
      if (!allowedConversation) return;
      const conversationResponse = await chatwootRequest(req.crmSession, {
        method: "GET",
        url: `${req.crmSession.chatwoot_base_url}/api/v1/accounts/${req.crmSession.chatwoot_account_id}/conversations/${conversationId}`,
      });
      const currentConversation = conversationResponse.status >= 200 && conversationResponse.status < 300
        ? conversationResponse.data?.data || conversationResponse.data?.payload || conversationResponse.data
        : null;
      const before = pickCrmAttributes(currentConversation?.custom_attributes);
      const effectiveAttributes = { ...customAttributes };
      const stageBefore = String(before?.crm_stage || "new");
      const stageAfter = String(effectiveAttributes.crm_stage || stageBefore);
      const terminalStages = new Set(["won", "lost"]);
      if (terminalStages.has(stageAfter)) {
        if (!terminalStages.has(stageBefore) || !effectiveAttributes.crm_outcome_at) {
          effectiveAttributes.crm_outcome_at = effectiveAttributes.crm_outcome_at || new Date().toISOString();
        }
      } else if (terminalStages.has(stageBefore) || effectiveAttributes.crm_outcome_at) {
        effectiveAttributes.crm_outcome_at = null;
      }
      const updateResponse = await chatwootRequest(req.crmSession, {
        method: "POST",
        url: `${req.crmSession.chatwoot_base_url}/api/v1/accounts/${req.crmSession.chatwoot_account_id}/conversations/${conversationId}/custom_attributes`,
        data: { custom_attributes: effectiveAttributes },
      });
      if (updateResponse.status >= 200 && updateResponse.status < 300) {
        db.syncTaskFromAttributes({
          organizationId: req.crmSession.organization_id,
          conversationId,
          attributes: effectiveAttributes,
          actorUserId: req.crmSession.user_id,
        });
        db.logAudit({
          organizationId: req.crmSession.organization_id,
          actorUserId: req.crmSession.user_id,
          action: "opportunity.updated",
          entityType: "conversation",
          entityId: conversationId,
          before,
          after: pickCrmAttributes(effectiveAttributes),
          metadata: {
            stageBefore,
            stageAfter,
          },
        });
      }
      if (updateResponse.status >= 200 && updateResponse.status < 300) {
        return res.status(updateResponse.status).json({
          ...(typeof updateResponse.data === "object" && updateResponse.data ? updateResponse.data : {}),
          effectiveCustomAttributes: effectiveAttributes,
        });
      }
      return relayAxiosResponse(res, updateResponse);
    } catch (error) {
      console.error("Erro ao atualizar oportunidade:", error.message);
      return res.status(502).json({ error: "Falha ao atualizar a oportunidade" });
    }
  }
);

app.use("/api/v1", requireSession, async (req, res) => {
  const session = req.crmSession;
  const allowedMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
  if (!allowedMethods.has(req.method)) {
    return res.status(405).json({ error: "Método não permitido" });
  }

  try {
    if (req.method !== "GET" && !hasPermission(session, "opportunities:write")) {
      return res.status(403).json({ error: "Seu perfil possui acesso somente para leitura" });
    }
    if (
      /\/messages(?:\?|$)/.test(req.url) &&
      req.method === "POST" &&
      !hasPermission(session, "messages:send")
    ) {
      return res.status(403).json({ error: "Seu perfil não pode enviar mensagens" });
    }

    const requestedAccountMatch = req.url.match(/^\/accounts\/(\d+)/);
    if (
      requestedAccountMatch &&
      Number(requestedAccountMatch[1]) !== Number(session.chatwoot_account_id)
    ) {
      return res.status(403).json({ error: "Conta diferente da organização autenticada" });
    }

    const isConversationCollection = /^\/accounts\/\d+\/conversations(?:\?|$)/.test(req.url);
    if (isConversationCollection) {
      return res.status(403).json({
        error: "Use o endpoint de escopo operacional para listar conversas",
      });
    }

    const conversationMatch = req.url.match(/^\/accounts\/\d+\/conversations\/(\d+)/);
    if (conversationMatch) {
      const conversationId = Number(conversationMatch[1]);
      const conversation = await requireConversationAccess(req, res, conversationId);
      if (!conversation) return;

      const isAssignmentWrite =
        /\/assignments(?:\?|$)/.test(req.url) && req.method === "POST";
      if (isAssignmentWrite && !hasPermission(session, "assignments:manage")) {
        return res.status(403).json({
          error: "Seu perfil não pode transferir oportunidades para outro responsável",
        });
      }
    } else if (session.visibility_scope !== "all") {
      const safeScopedCollection =
        req.method === "GET" &&
        /^\/accounts\/\d+\/(agents|teams|inboxes|labels)(?:\?|$)/.test(req.url);
      if (!safeScopedCollection) {
        return res.status(403).json({
          error: "Este recurso não está disponível para o seu escopo operacional",
        });
      }
    }

    const response = await chatwootRequest(session, {
      method: req.method,
      url: `${session.chatwoot_base_url}/api/v1${req.url}`,
      data: ["POST", "PUT", "PATCH"].includes(req.method) ? req.body : undefined,
    });
    if (req.method !== "GET" && response.status >= 200 && response.status < 300) {
      const isMessage = /\/messages(?:\?|$)/.test(req.url);
      db.logAudit({
        organizationId: session.organization_id,
        actorUserId: session.user_id,
        action: isMessage ? "chatwoot.message.created" : `chatwoot.${req.method.toLowerCase()}`,
        entityType: "chatwoot_request",
        entityId: req.url.match(/\/conversations\/(\d+)/)?.[1] || null,
        metadata: {
          path: req.url.slice(0, 300),
          private: isMessage ? Boolean(req.body?.private) : undefined,
        },
      });
    }
    return relayAxiosResponse(res, response);
  } catch (error) {
    console.error("Erro no proxy do Chatwoot:", error.message);
    return res.status(error.status || 502).json({
      error: error.message || "Erro ao processar a requisição",
      details: error.response || undefined,
    });
  }
});

app.get("/build-url-to-redirect", requireSession, async (req, res) => {
  const conversationId = Number(req.query.conversationId);
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return res.status(400).json({ error: "conversationId inválido" });
  }
  try {
    const conversation = await requireConversationAccess(req, res, conversationId);
    if (!conversation) return;
    return res.json({
      url: `${req.crmSession.chatwoot_base_url}/app/accounts/${req.crmSession.chatwoot_account_id}/conversations/${conversationId}`,
    });
  } catch (error) {
    console.error("Erro ao gerar link do Chatwoot:", error.message);
    return res.status(error.status || 502).json({
      error: error.message || "Falha ao gerar link da conversa",
      details: error.response || undefined,
    });
  }
});

app.use((error, _req, res, _next) => {
  console.error("Erro não tratado:", error);
  return res.status(500).json({ error: "Erro interno do CRM" });
});

setInterval(db.cleanupSessions, 15 * 60 * 1000).unref();

const staleReactivationCount = db.markStaleReactivationProcessingUncertain(0);
if (staleReactivationCount > 0) {
  console.warn(`${staleReactivationCount} envio(s) de reativação ficaram como incertos após reinício; revisão manual necessária.`);
}
if (REACTIVATION_CONFIG.sendEnabled) {
  setInterval(processNextReactivationRecipient, REACTIVATION_CONFIG.intervalMs).unref();
  console.log(`Worker de reativação manual ativo: 1 envio por ciclo de ${REACTIVATION_CONFIG.intervalMs}ms.`);
} else {
  console.log("Reativação manual disponível para revisão; envio desativado por REACTIVATION_SEND_ENABLED=false.");
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`CRM central V1.3.6 rodando na porta ${PORT}`);
  console.log(`Banco central: ${db.databasePath}`);
});
