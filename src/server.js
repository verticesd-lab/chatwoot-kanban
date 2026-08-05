const express = require("express");
const axios = require("axios");
const path = require("path");
const crypto = require("crypto");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) {
    throw new Error("BASE_URL não configurada");
  }
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

const CHATWOOT_BASE_URL = normalizeBaseUrl(process.env.BASE_URL);

app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname)));

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

function getSession(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const sessionId = cookies.crm_session;
  if (!sessionId) return null;

  const session = sessions.get(sessionId);
  if (!session) return null;

  if (Date.now() > session.expiresAt) {
    sessions.delete(sessionId);
    return null;
  }

  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return { id: sessionId, ...session };
}

function requireSession(req, res, next) {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: "Sessão não autenticada" });
  }
  req.crmSession = session;
  next();
}

function chatwootHeaders(token) {
  return {
    api_access_token: token,
    "Content-Type": "application/json",
  };
}

async function chatwootRequest(session, options) {
  return axios({
    timeout: 20000,
    validateStatus: () => true,
    ...options,
    headers: {
      ...chatwootHeaders(session.token),
      ...(options.headers || {}),
    },
  });
}

function relayAxiosResponse(res, response) {
  const contentType = response.headers?.["content-type"];
  if (contentType) res.setHeader("content-type", contentType);
  return res.status(response.status).send(response.data);
}

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    app: "chatwoot-crm-kanban",
    version: "1.1.1",
  });
});

app.post("/api/session", async (req, res) => {
  const token = String(req.body?.token || "").trim();
  const accountId = Number(req.body?.accountId);

  if (!token || !Number.isInteger(accountId) || accountId <= 0) {
    return res.status(400).json({
      error: "Informe um token válido e o ID numérico da conta",
    });
  }

  try {
    const validation = await axios.get(
      `${CHATWOOT_BASE_URL}/api/v1/accounts/${accountId}/conversations?status=all&page=1`,
      {
        timeout: 15000,
        validateStatus: () => true,
        headers: chatwootHeaders(token),
      }
    );

    if (validation.status < 200 || validation.status >= 300) {
      return res.status(validation.status).json({
        error: "Não foi possível autenticar no Chatwoot",
        details: validation.data,
      });
    }

    const sessionId = crypto.randomBytes(32).toString("hex");
    sessions.set(sessionId, {
      token,
      accountId,
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
    });

    res.setHeader("Set-Cookie", sessionCookie(sessionId, req));
    return res.json({ connected: true, accountId });
  } catch (error) {
    console.error("Erro ao autenticar no Chatwoot:", error.message);
    return res.status(502).json({
      error: "Falha de comunicação com o Chatwoot",
    });
  }
});

app.get("/api/session", (req, res) => {
  const session = getSession(req);
  if (!session) {
    return res.json({ connected: false });
  }
  return res.json({ connected: true, accountId: session.accountId });
});

app.delete("/api/session", (req, res) => {
  const cookies = parseCookies(req.headers.cookie || "");
  if (cookies.crm_session) sessions.delete(cookies.crm_session);
  res.setHeader("Set-Cookie", clearSessionCookie(req));
  return res.status(204).send();
});

const CRM_ATTRIBUTE_DEFINITIONS = [
  {
    attribute_display_name: "Etapa do CRM",
    attribute_display_type: 6,
    attribute_description: "Etapa comercial independente do status da conversa",
    attribute_key: "crm_stage",
    attribute_values: [
      "new",
      "contacted",
      "qualification",
      "proposal",
      "negotiation",
      "won",
      "lost",
    ],
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

app.post("/api/crm/bootstrap", requireSession, async (req, res) => {
  const session = req.crmSession;
  const listUrl = `${CHATWOOT_BASE_URL}/api/v1/accounts/${session.accountId}/custom_attribute_definitions?attribute_model=0`;

  try {
    const currentResponse = await chatwootRequest(session, {
      method: "GET",
      url: listUrl,
    });

    if (currentResponse.status < 200 || currentResponse.status >= 300) {
      return relayAxiosResponse(res, currentResponse);
    }

    const current = Array.isArray(currentResponse.data)
      ? currentResponse.data
      : currentResponse.data?.payload || [];
    const existingKeys = new Set(current.map((item) => item.attribute_key));
    const created = [];
    const skipped = [];
    const errors = [];

    for (const definition of CRM_ATTRIBUTE_DEFINITIONS) {
      if (existingKeys.has(definition.attribute_key)) {
        skipped.push(definition.attribute_key);
        continue;
      }

      const createResponse = await chatwootRequest(session, {
        method: "POST",
        url: `${CHATWOOT_BASE_URL}/api/v1/accounts/${session.accountId}/custom_attribute_definitions`,
        data: definition,
      });

      if (createResponse.status >= 200 && createResponse.status < 300) {
        created.push(definition.attribute_key);
      } else {
        errors.push({
          key: definition.attribute_key,
          status: createResponse.status,
          response: createResponse.data,
        });
      }
    }

    return res.status(errors.length ? 207 : 200).json({
      configured: errors.length === 0,
      created,
      skipped,
      errors,
    });
  } catch (error) {
    console.error("Erro ao inicializar atributos CRM:", error.message);
    return res.status(502).json({ error: "Falha ao configurar os atributos do CRM" });
  }
});

app.use("/api/v1", requireSession, async (req, res) => {
  const session = req.crmSession;
  const allowedMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

  if (!allowedMethods.has(req.method)) {
    return res.status(405).json({ error: "Método não permitido" });
  }

  const requestedAccountMatch = req.url.match(/^\/accounts\/(\d+)/);
  if (
    requestedAccountMatch &&
    Number(requestedAccountMatch[1]) !== session.accountId
  ) {
    return res.status(403).json({ error: "Conta diferente da sessão autenticada" });
  }

  try {
    const response = await chatwootRequest(session, {
      method: req.method,
      url: `${CHATWOOT_BASE_URL}/api/v1${req.url}`,
      data: ["POST", "PUT", "PATCH"].includes(req.method) ? req.body : undefined,
    });
    return relayAxiosResponse(res, response);
  } catch (error) {
    console.error("Erro no proxy do Chatwoot:", error.message);
    return res.status(502).json({ error: "Erro ao processar a requisição" });
  }
});

app.get("/build-url-to-redirect", requireSession, (req, res) => {
  const conversationId = Number(req.query.conversationId);
  const accountId = req.crmSession.accountId;

  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return res.status(400).json({ error: "conversationId inválido" });
  }

  return res.json({
    url: `${CHATWOOT_BASE_URL}/app/accounts/${accountId}/conversations/${conversationId}`,
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now > session.expiresAt) sessions.delete(sessionId);
  }
}, 15 * 60 * 1000).unref();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`CRM Kanban rodando na porta ${PORT}`);
});
