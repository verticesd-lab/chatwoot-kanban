const express = require("express");
const axios = require("axios");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config();
const db = require("./db");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL_MS = Number(process.env.CRM_SESSION_TTL_HOURS || 12) * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const loginAttempts = new Map();

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
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  next();
});
app.use(express.json({ limit: "1mb" }));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/script.js", (_req, res) => res.sendFile(path.join(__dirname, "script.js")));
app.get("/styles.css", (_req, res) => res.sendFile(path.join(__dirname, "styles.css")));

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
    version: "1.3.0-central",
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
];

app.get("/api/crm/config", requireSession, (req, res) => {
  const session = req.crmSession;
  return res.json({
    ...db.sessionPayload(session),
    pipeline: db.getDefaultPipeline(session.organization_id),
    filterPresets: db.listFilterPresets(session.organization_id, session.user_id),
  });
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
  const role = ["admin", "manager", "agent", "viewer"].includes(req.body?.role)
    ? req.body.role
    : "agent";
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
      role,
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
  const role = req.body?.role && ["admin", "manager", "agent", "viewer"].includes(req.body.role)
    ? req.body.role
    : undefined;
  const password = req.body?.password ? String(req.body.password) : undefined;
  if (password && password.length < 10) {
    return res.status(400).json({ error: "A nova senha deve possuir pelo menos 10 caracteres" });
  }
  const user = db.updateUser({
    organizationId: req.crmSession.organization_id,
    actorUserId: req.crmSession.user_id,
    userId: req.params.id,
    name: req.body?.name ? String(req.body.name).trim().slice(0, 80) : undefined,
    role,
    active: typeof req.body?.active === "boolean" ? req.body.active : undefined,
    password,
  });
  if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
  return res.json({ user });
});

app.get("/api/crm/audit", requireSession, requirePermission("audit:read"), (req, res) => {
  return res.json({ audit: db.listAudit(req.crmSession.organization_id, req.query.limit) });
});

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
      const conversationResponse = await chatwootRequest(req.crmSession, {
        method: "GET",
        url: `${req.crmSession.chatwoot_base_url}/api/v1/accounts/${req.crmSession.chatwoot_account_id}/conversations/${conversationId}`,
      });
      const currentConversation = conversationResponse.status >= 200 && conversationResponse.status < 300
        ? conversationResponse.data?.data || conversationResponse.data?.payload || conversationResponse.data
        : null;
      const before = pickCrmAttributes(currentConversation?.custom_attributes);
      const updateResponse = await chatwootRequest(req.crmSession, {
        method: "POST",
        url: `${req.crmSession.chatwoot_base_url}/api/v1/accounts/${req.crmSession.chatwoot_account_id}/conversations/${conversationId}/custom_attributes`,
        data: { custom_attributes: customAttributes },
      });
      if (updateResponse.status >= 200 && updateResponse.status < 300) {
        db.syncTaskFromAttributes({
          organizationId: req.crmSession.organization_id,
          conversationId,
          attributes: customAttributes,
          actorUserId: req.crmSession.user_id,
        });
        db.logAudit({
          organizationId: req.crmSession.organization_id,
          actorUserId: req.crmSession.user_id,
          action: "opportunity.updated",
          entityType: "conversation",
          entityId: conversationId,
          before,
          after: pickCrmAttributes(customAttributes),
          metadata: {
            stageBefore: before?.crm_stage || null,
            stageAfter: customAttributes.crm_stage || null,
          },
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
  if (!allowedMethods.has(req.method)) return res.status(405).json({ error: "Método não permitido" });

  if (req.method !== "GET" && !hasPermission(session, "opportunities:write")) {
    return res.status(403).json({ error: "Seu perfil possui acesso somente para leitura" });
  }
  if (/\/messages(?:\?|$)/.test(req.url) && req.method === "POST" && !hasPermission(session, "messages:send")) {
    return res.status(403).json({ error: "Seu perfil não pode enviar mensagens" });
  }

  const requestedAccountMatch = req.url.match(/^\/accounts\/(\d+)/);
  if (requestedAccountMatch && Number(requestedAccountMatch[1]) !== Number(session.chatwoot_account_id)) {
    return res.status(403).json({ error: "Conta diferente da organização autenticada" });
  }

  try {
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
    return res.status(502).json({ error: "Erro ao processar a requisição" });
  }
});

app.get("/build-url-to-redirect", requireSession, (req, res) => {
  const conversationId = Number(req.query.conversationId);
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return res.status(400).json({ error: "conversationId inválido" });
  }
  return res.json({
    url: `${req.crmSession.chatwoot_base_url}/app/accounts/${req.crmSession.chatwoot_account_id}/conversations/${conversationId}`,
  });
});

app.use((error, _req, res, _next) => {
  console.error("Erro não tratado:", error);
  return res.status(500).json({ error: "Erro interno do CRM" });
});

setInterval(db.cleanupSessions, 15 * 60 * 1000).unref();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`CRM central V1.3 rodando na porta ${PORT}`);
  console.log(`Banco central: ${db.databasePath}`);
});
