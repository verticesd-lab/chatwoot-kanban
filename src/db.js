const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DEFAULT_STAGES = [
  { id: "new", label: "Novo lead", color: "#2563eb", archived: false, locked: true, terminal: false },
  { id: "contacted", label: "Contato iniciado", color: "#0ea5e9", archived: false, locked: false, terminal: false },
  { id: "qualification", label: "Qualificação", color: "#8b5cf6", archived: false, locked: false, terminal: false },
  { id: "proposal", label: "Proposta", color: "#f59e0b", archived: false, locked: false, terminal: false },
  { id: "negotiation", label: "Negociação", color: "#f97316", archived: false, locked: false, terminal: false },
  { id: "won", label: "Ganho", color: "#10b981", archived: false, locked: true, terminal: true },
  { id: "lost", label: "Perdido", color: "#ef4444", archived: false, locked: true, terminal: true },
];

const ROLE_PERMISSIONS = {
  admin: [
    "crm:read",
    "opportunities:write",
    "messages:send",
    "pipeline:manage",
    "filters:share",
    "users:manage",
    "audit:read",
    "assignments:manage",
    "interventions:manage",
    "archive:manage",
    "transfer_requests:manage",
    "presence:read",
    "tutorials:manage",
  ],
  manager: [
    "crm:read",
    "opportunities:write",
    "messages:send",
    "pipeline:manage",
    "filters:share",
    "audit:read",
    "assignments:manage",
    "interventions:manage",
    "archive:manage",
    "transfer_requests:manage",
    "presence:read",
    "tutorials:manage",
  ],
  agent: ["crm:read", "opportunities:write", "messages:send", "presence:read"],
  viewer: ["crm:read", "presence:read"],
};

const OPERATIONAL_PROFILES = {
  admin: { membershipRole: "admin", visibilityScope: "all" },
  manager: { membershipRole: "manager", visibilityScope: "all" },
  sdr: { membershipRole: "agent", visibilityScope: "unassigned_and_mine" },
  seller: { membershipRole: "agent", visibilityScope: "mine" },
  agent: { membershipRole: "agent", visibilityScope: "all" },
  viewer: { membershipRole: "viewer", visibilityScope: "all" },
};

const OPERATIONAL_PERMISSIONS = {
  admin: ["assignments:manage", "interventions:manage"],
  manager: ["assignments:manage", "interventions:manage"],
  sdr: ["interventions:manage"],
  seller: ["interventions:manage"],
  agent: ["assignments:manage", "interventions:manage"],
  viewer: [],
};

function normalizeOperationalProfile(value, fallbackRole = "agent") {
  const key = String(value || "").trim().toLowerCase();
  if (OPERATIONAL_PROFILES[key]) return key;
  if (fallbackRole === "admin") return "admin";
  if (fallbackRole === "manager") return "manager";
  if (fallbackRole === "viewer") return "viewer";
  return "agent";
}

function normalizeVisibilityScope(value, operationalRole) {
  if (["admin", "manager"].includes(operationalRole)) return "all";
  const requested = String(value || "").trim();
  const allowed = new Set(["all", "mine", "unassigned_and_mine", "unassigned"]);
  if (allowed.has(requested)) return requested;
  return OPERATIONAL_PROFILES[operationalRole]?.visibilityScope || "all";
}

function permissionsFor(role, operationalRole) {
  return [...new Set([
    ...(ROLE_PERMISSIONS[role] || []),
    ...(OPERATIONAL_PERMISSIONS[operationalRole] || []),
  ])];
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, stored) {
  const [algorithm, salt, expectedHex] = String(stored || "").split("$");
  if (algorithm !== "scrypt" || !salt || !expectedHex) return false;
  const actual = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function encryptionKey() {
  const secret = String(process.env.CRM_ENCRYPTION_KEY || "").trim();
  if (secret.length < 24) {
    throw new Error("CRM_ENCRYPTION_KEY deve possuir pelo menos 24 caracteres");
  }
  return crypto.createHash("sha256").update(secret).digest();
}

function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

function decryptSecret(value) {
  const [ivEncoded, tagEncoded, encryptedEncoded] = String(value || "").split(".");
  if (!ivEncoded || !tagEncoded || !encryptedEncoded) throw new Error("Segredo criptografado inválido");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivEncoded, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedEncoded, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function safeJsonParse(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (_error) {
    return fallback;
  }
}

function ensureColumn(database, tableName, columnName, definition) {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some((column) => column.name === columnName)) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function createDatabase() {
  const databasePath = path.resolve(process.env.CRM_DB_PATH || path.join(process.cwd(), "data", "crm.sqlite"));
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      chatwoot_base_url TEXT NOT NULL,
      chatwoot_account_id INTEGER NOT NULL,
      chatwoot_token_encrypted TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memberships (
      user_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','manager','agent','viewer')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, organization_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pipelines (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pipeline_stages (
      id TEXT PRIMARY KEY,
      pipeline_id TEXT NOT NULL,
      stage_key TEXT NOT NULL,
      label TEXT NOT NULL,
      color TEXT NOT NULL,
      position INTEGER NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      locked INTEGER NOT NULL DEFAULT 0,
      terminal INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (pipeline_id, stage_key),
      FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS filter_presets (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('personal','shared')),
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS crm_tasks (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      conversation_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      due_date TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending','overdue','done')),
      completed_at TEXT,
      created_by_user_id TEXT,
      updated_by_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (organization_id, conversation_id),
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS organization_settings (
      organization_id TEXT NOT NULL,
      setting_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, setting_key),
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      actor_user_id TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      before_json TEXT,
      after_json TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS interventions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      conversation_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      trigger_labels_json TEXT NOT NULL DEFAULT '[]',
      assignee_agent_id INTEGER,
      first_detected_at TEXT NOT NULL,
      last_detected_at TEXT NOT NULL,
      assumed_by_user_id TEXT,
      assumed_at TEXT,
      resolved_by_user_id TEXT,
      resolved_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE (organization_id, conversation_id),
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_presence (
      user_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_action_at TEXT NOT NULL,
      last_path TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, organization_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS archived_opportunities (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      conversation_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      note TEXT,
      archived_by_user_id TEXT,
      archived_at TEXT NOT NULL,
      restored_by_user_id TEXT,
      restored_at TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      UNIQUE (organization_id, conversation_id),
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY (archived_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (restored_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS transfer_requests (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      conversation_id INTEGER NOT NULL,
      requested_by_user_id TEXT NOT NULL,
      request_type TEXT NOT NULL DEFAULT 'redistribution',
      reason TEXT NOT NULL,
      previous_agent_id INTEGER,
      target_agent_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
      resolved_by_user_id TEXT,
      resolution_note TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY (requested_by_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (resolved_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS tutorial_videos (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      youtube_video_id TEXT NOT NULL,
      youtube_url TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL DEFAULT 'Geral',
      display_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_by_user_id TEXT,
      updated_by_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (organization_id, youtube_video_id),
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_stages_pipeline_position ON pipeline_stages(pipeline_id, position);
    CREATE INDEX IF NOT EXISTS idx_filters_org_owner ON filter_presets(organization_id, owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_org_due ON crm_tasks(organization_id, due_date);
    CREATE INDEX IF NOT EXISTS idx_audit_org_created ON audit_logs(organization_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_interventions_org_status ON interventions(organization_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_presence_org_seen ON user_presence(organization_id, last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_archive_org_active ON archived_opportunities(organization_id, active, archived_at DESC);
    CREATE INDEX IF NOT EXISTS idx_transfer_org_status ON transfer_requests(organization_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tutorials_org_active_order ON tutorial_videos(organization_id, active, display_order, created_at);
  `);

  ensureColumn(db, "memberships", "operational_role", "TEXT NOT NULL DEFAULT 'agent'");
  ensureColumn(db, "memberships", "chatwoot_agent_id", "INTEGER");
  ensureColumn(db, "memberships", "visibility_scope", "TEXT NOT NULL DEFAULT 'all'");

  db.exec(`
    UPDATE memberships
    SET operational_role = CASE role
      WHEN 'admin' THEN 'admin'
      WHEN 'manager' THEN 'manager'
      WHEN 'viewer' THEN 'viewer'
      ELSE COALESCE(NULLIF(operational_role, ''), 'agent')
    END
    WHERE operational_role IS NULL OR operational_role = '' OR operational_role = 'agent';

    UPDATE memberships
    SET visibility_scope = CASE operational_role
      WHEN 'sdr' THEN 'unassigned_and_mine'
      WHEN 'seller' THEN 'mine'
      ELSE COALESCE(NULLIF(visibility_scope, ''), 'all')
    END
    WHERE visibility_scope IS NULL OR visibility_scope = '';
  `);

  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?)").run(nowIso());
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, ?)").run(nowIso());
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (3, ?)").run(nowIso());
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (4, ?)").run(nowIso());

  return { db, databasePath };
}

const { db, databasePath } = createDatabase();

function transaction(callback) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || `empresa-${Date.now()}`;
}

function ensureDefaultPipeline(organizationId) {
  let pipeline = db
    .prepare("SELECT * FROM pipelines WHERE organization_id = ? ORDER BY is_default DESC, created_at LIMIT 1")
    .get(organizationId);
  if (pipeline) return pipeline;

  const pipelineId = crypto.randomUUID();
  const now = nowIso();
  transaction(() => {
    db.prepare(
      "INSERT INTO pipelines (id, organization_id, name, is_default, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
    ).run(pipelineId, organizationId, "Pipeline comercial", now, now);
    const insert = db.prepare(`
      INSERT INTO pipeline_stages
      (id, pipeline_id, stage_key, label, color, position, archived, locked, terminal, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    DEFAULT_STAGES.forEach((stage, index) => {
      insert.run(
        crypto.randomUUID(),
        pipelineId,
        stage.id,
        stage.label,
        stage.color,
        index,
        stage.archived ? 1 : 0,
        stage.locked ? 1 : 0,
        stage.terminal ? 1 : 0,
        now,
        now
      );
    });
  });
  return db.prepare("SELECT * FROM pipelines WHERE id = ?").get(pipelineId);
}

function bootstrapFromEnv(baseUrl) {
  const existing = db.prepare("SELECT COUNT(*) AS total FROM organizations").get().total;
  if (existing > 0) return { bootstrapped: false };

  const organizationName = String(process.env.CRM_ORGANIZATION_NAME || "").trim();
  const adminName = String(process.env.CRM_ADMIN_NAME || "Administrador").trim();
  const adminEmail = normalizeEmail(process.env.CRM_ADMIN_EMAIL);
  const adminPassword = String(process.env.CRM_ADMIN_PASSWORD || "");
  const accountId = Number(process.env.CHATWOOT_ACCOUNT_ID);
  const token = String(process.env.CHATWOOT_API_TOKEN || "").trim();

  const missing = [];
  if (!organizationName) missing.push("CRM_ORGANIZATION_NAME");
  if (!adminEmail) missing.push("CRM_ADMIN_EMAIL");
  if (adminPassword.length < 10) missing.push("CRM_ADMIN_PASSWORD (mínimo 10 caracteres)");
  if (!Number.isInteger(accountId) || accountId <= 0) missing.push("CHATWOOT_ACCOUNT_ID");
  if (!token) missing.push("CHATWOOT_API_TOKEN");
  encryptionKey();

  if (missing.length) {
    throw new Error(`Primeira inicialização incompleta. Configure: ${missing.join(", ")}`);
  }

  const organizationId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const now = nowIso();
  transaction(() => {
    db.prepare(`
      INSERT INTO organizations
      (id, name, slug, chatwoot_base_url, chatwoot_account_id, chatwoot_token_encrypted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      organizationId,
      organizationName,
      slugify(organizationName),
      baseUrl,
      accountId,
      encryptSecret(token),
      now,
      now
    );
    db.prepare(`
      INSERT INTO users (id, email, name, password_hash, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `).run(userId, adminEmail, adminName, hashPassword(adminPassword), now, now);
    db.prepare(`
      INSERT INTO memberships
      (user_id, organization_id, role, operational_role, visibility_scope, created_at, updated_at)
      VALUES (?, ?, 'admin', 'admin', 'all', ?, ?)
    `).run(userId, organizationId, now, now);
  });
  ensureDefaultPipeline(organizationId);
  logAudit({
    organizationId,
    actorUserId: userId,
    action: "organization.bootstrap",
    entityType: "organization",
    entityId: organizationId,
    after: { name: organizationName, accountId },
  });
  return { bootstrapped: true, organizationId, userId };
}

function authenticate(email, password) {
  const user = db.prepare(`
    SELECT u.*, m.organization_id, m.role, m.operational_role,
           m.chatwoot_agent_id, m.visibility_scope, o.name AS organization_name,
           o.slug AS organization_slug, o.chatwoot_account_id, o.chatwoot_base_url,
           o.chatwoot_token_encrypted
    FROM users u
    JOIN memberships m ON m.user_id = u.id
    JOIN organizations o ON o.id = m.organization_id
    WHERE u.email = ? AND u.active = 1
    ORDER BY m.created_at
    LIMIT 1
  `).get(normalizeEmail(email));
  if (!user || !verifyPassword(password, user.password_hash)) return null;
  return user;
}

function createSession(user, ttlMs) {
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  db.prepare(`
    INSERT INTO sessions (token_hash, user_id, organization_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(tokenHash, user.id, user.organization_id, createdAt, expiresAt);
  return { rawToken, expiresAt };
}

function getSession(rawToken) {
  if (!rawToken) return null;
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const session = db.prepare(`
    SELECT s.token_hash, s.created_at AS session_created_at, s.expires_at,
           u.id AS user_id, u.email, u.name AS user_name, u.active,
           m.role, m.operational_role, m.chatwoot_agent_id, m.visibility_scope,
           o.id AS organization_id, o.name AS organization_name,
           o.slug AS organization_slug, o.chatwoot_account_id,
           o.chatwoot_base_url, o.chatwoot_token_encrypted
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    JOIN memberships m ON m.user_id = u.id AND m.organization_id = s.organization_id
    JOIN organizations o ON o.id = s.organization_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1
  `).get(tokenHash, nowIso());
  if (!session) return null;
  return {
    ...session,
    operational_role: normalizeOperationalProfile(session.operational_role, session.role),
    visibility_scope: normalizeVisibilityScope(
      session.visibility_scope,
      normalizeOperationalProfile(session.operational_role, session.role)
    ),
    permissions: permissionsFor(
      session.role,
      normalizeOperationalProfile(session.operational_role, session.role)
    ),
    chatwootToken: decryptSecret(session.chatwoot_token_encrypted),
  };
}

function deleteSession(rawToken) {
  if (!rawToken) return;
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

function cleanupSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso());
}

function sessionPayload(session) {
  return {
    connected: true,
    accountId: Number(session.chatwoot_account_id),
    organization: {
      id: session.organization_id,
      name: session.organization_name,
      slug: session.organization_slug,
    },
    user: {
      id: session.user_id,
      name: session.user_name,
      email: session.email,
      role: session.role,
      operationalRole: session.operational_role,
      chatwootAgentId: session.chatwoot_agent_id ? Number(session.chatwoot_agent_id) : null,
      visibilityScope: session.visibility_scope,
    },
    permissions: session.permissions,
  };
}

function getDefaultPipeline(organizationId) {
  const pipeline = ensureDefaultPipeline(organizationId);
  const stages = db.prepare(`
    SELECT stage_key AS id, label, color, archived, locked, terminal, position
    FROM pipeline_stages
    WHERE pipeline_id = ?
    ORDER BY position, created_at
  `).all(pipeline.id).map((stage) => ({
    ...stage,
    archived: Boolean(stage.archived),
    locked: Boolean(stage.locked),
    terminal: Boolean(stage.terminal),
  }));
  return { id: pipeline.id, name: pipeline.name, stages };
}

function replacePipelineStages(organizationId, stages, actorUserId) {
  const pipeline = ensureDefaultPipeline(organizationId);
  const before = getDefaultPipeline(organizationId).stages;
  const now = nowIso();
  transaction(() => {
    db.prepare("DELETE FROM pipeline_stages WHERE pipeline_id = ?").run(pipeline.id);
    const insert = db.prepare(`
      INSERT INTO pipeline_stages
      (id, pipeline_id, stage_key, label, color, position, archived, locked, terminal, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stages.forEach((stage, index) => {
      insert.run(
        crypto.randomUUID(),
        pipeline.id,
        stage.id,
        stage.label,
        stage.color,
        index,
        stage.archived ? 1 : 0,
        stage.locked ? 1 : 0,
        stage.terminal ? 1 : 0,
        now,
        now
      );
    });
  });
  const after = getDefaultPipeline(organizationId).stages;
  logAudit({
    organizationId,
    actorUserId,
    action: "pipeline.stages.updated",
    entityType: "pipeline",
    entityId: pipeline.id,
    before,
    after,
  });
  return after;
}

function listFilterPresets(organizationId, userId) {
  return db.prepare(`
    SELECT f.id, f.name, f.scope, f.owner_user_id, f.snapshot_json, f.created_at, f.updated_at,
           u.name AS owner_name
    FROM filter_presets f
    JOIN users u ON u.id = f.owner_user_id
    WHERE f.organization_id = ? AND (f.scope = 'shared' OR f.owner_user_id = ?)
    ORDER BY CASE f.scope WHEN 'shared' THEN 0 ELSE 1 END, f.name
  `).all(organizationId, userId).map((row) => ({
    ...safeJsonParse(row.snapshot_json, {}),
    id: row.id,
    name: row.name,
    scope: row.scope,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name,
  }));
}

function createFilterPreset({ organizationId, userId, name, scope, snapshot }) {
  const id = crypto.randomUUID();
  const now = nowIso();
  db.prepare(`
    INSERT INTO filter_presets
    (id, organization_id, owner_user_id, name, scope, snapshot_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, organizationId, userId, name, scope, JSON.stringify(snapshot), now, now);
  logAudit({
    organizationId,
    actorUserId: userId,
    action: "filter.created",
    entityType: "filter_preset",
    entityId: id,
    after: { name, scope },
  });
  return listFilterPresets(organizationId, userId).find((item) => item.id === id);
}

function deleteFilterPreset({ organizationId, userId, filterId, canManageShared }) {
  const filter = db.prepare("SELECT * FROM filter_presets WHERE id = ? AND organization_id = ?").get(filterId, organizationId);
  if (!filter) return false;
  if (filter.owner_user_id !== userId && !(filter.scope === "shared" && canManageShared)) {
    const error = new Error("Você não possui permissão para excluir este filtro");
    error.status = 403;
    throw error;
  }
  db.prepare("DELETE FROM filter_presets WHERE id = ?").run(filterId);
  logAudit({
    organizationId,
    actorUserId: userId,
    action: "filter.deleted",
    entityType: "filter_preset",
    entityId: filterId,
    before: { name: filter.name, scope: filter.scope },
  });
  return true;
}

function listUsers(organizationId) {
  return db.prepare(`
    SELECT u.id, u.name, u.email, u.active, m.role, m.operational_role,
           m.chatwoot_agent_id, m.visibility_scope, u.created_at, u.updated_at
    FROM users u
    JOIN memberships m ON m.user_id = u.id
    WHERE m.organization_id = ?
    ORDER BY u.active DESC, u.name
  `).all(organizationId).map((user) => ({
    ...user,
    active: Boolean(user.active),
    operationalRole: normalizeOperationalProfile(user.operational_role, user.role),
    chatwootAgentId: user.chatwoot_agent_id ? Number(user.chatwoot_agent_id) : null,
    visibilityScope: normalizeVisibilityScope(
      user.visibility_scope,
      normalizeOperationalProfile(user.operational_role, user.role)
    ),
  }));
}

function createUser({
  organizationId,
  actorUserId,
  name,
  email,
  password,
  role,
  operationalRole,
  chatwootAgentId,
  visibilityScope,
}) {
  const normalizedEmail = normalizeEmail(email);
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(normalizedEmail);
  if (existing) {
    const error = new Error("Já existe um usuário com este e-mail");
    error.status = 409;
    throw error;
  }

  const normalizedOperationalRole = normalizeOperationalProfile(operationalRole || role, role);
  const membershipRole = OPERATIONAL_PROFILES[normalizedOperationalRole]?.membershipRole || "agent";
  const normalizedScope = normalizeVisibilityScope(visibilityScope, normalizedOperationalRole);
  const linkedAgentId = Number(chatwootAgentId);
  const safeAgentId = Number.isInteger(linkedAgentId) && linkedAgentId > 0 ? linkedAgentId : null;

  if (["sdr", "seller"].includes(normalizedOperationalRole) && !safeAgentId) {
    const error = new Error("Vincule o usuário a um agente do Chatwoot");
    error.status = 400;
    throw error;
  }

  const id = crypto.randomUUID();
  const now = nowIso();
  transaction(() => {
    db.prepare(`
      INSERT INTO users (id, email, name, password_hash, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `).run(id, normalizedEmail, name, hashPassword(password), now, now);
    db.prepare(`
      INSERT INTO memberships
      (user_id, organization_id, role, operational_role, chatwoot_agent_id,
       visibility_scope, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      organizationId,
      membershipRole,
      normalizedOperationalRole,
      safeAgentId,
      normalizedScope,
      now,
      now
    );
  });
  logAudit({
    organizationId,
    actorUserId,
    action: "user.created",
    entityType: "user",
    entityId: id,
    after: {
      name,
      email: normalizedEmail,
      role: membershipRole,
      operationalRole: normalizedOperationalRole,
      chatwootAgentId: safeAgentId,
      visibilityScope: normalizedScope,
    },
  });
  return listUsers(organizationId).find((user) => user.id === id);
}

function updateUser({
  organizationId,
  actorUserId,
  userId,
  role,
  operationalRole,
  chatwootAgentId,
  visibilityScope,
  active,
  name,
  password,
}) {
  const current = db.prepare(`
    SELECT u.*, m.role, m.operational_role, m.chatwoot_agent_id, m.visibility_scope
    FROM users u
    JOIN memberships m ON m.user_id = u.id
    WHERE u.id = ? AND m.organization_id = ?
  `).get(userId, organizationId);
  if (!current) return null;

  const nextOperationalRole = normalizeOperationalProfile(
    operationalRole || role || current.operational_role,
    current.role
  );
  const nextMembershipRole = OPERATIONAL_PROFILES[nextOperationalRole]?.membershipRole || current.role;
  const nextVisibilityScope = normalizeVisibilityScope(
    visibilityScope || current.visibility_scope,
    nextOperationalRole
  );
  const requestedAgentId = chatwootAgentId === undefined
    ? current.chatwoot_agent_id
    : Number(chatwootAgentId);
  const nextAgentId = Number.isInteger(Number(requestedAgentId)) && Number(requestedAgentId) > 0
    ? Number(requestedAgentId)
    : null;

  if (["sdr", "seller"].includes(nextOperationalRole) && !nextAgentId) {
    const error = new Error("Vincule o usuário a um agente do Chatwoot");
    error.status = 400;
    throw error;
  }

  const now = nowIso();
  transaction(() => {
    db.prepare("UPDATE users SET name = ?, active = ?, updated_at = ? WHERE id = ?")
      .run(name || current.name, active === undefined ? current.active : active ? 1 : 0, now, userId);
    db.prepare(`
      UPDATE memberships
      SET role = ?, operational_role = ?, chatwoot_agent_id = ?, visibility_scope = ?, updated_at = ?
      WHERE user_id = ? AND organization_id = ?
    `).run(
      nextMembershipRole,
      nextOperationalRole,
      nextAgentId,
      nextVisibilityScope,
      now,
      userId,
      organizationId
    );
    if (password) {
      db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
        .run(hashPassword(password), now, userId);
    }
  });
  logAudit({
    organizationId,
    actorUserId,
    action: "user.updated",
    entityType: "user",
    entityId: userId,
    before: {
      name: current.name,
      active: Boolean(current.active),
      role: current.role,
      operationalRole: current.operational_role,
      chatwootAgentId: current.chatwoot_agent_id,
      visibilityScope: current.visibility_scope,
    },
    after: {
      name: name || current.name,
      active: active === undefined ? Boolean(current.active) : Boolean(active),
      role: nextMembershipRole,
      operationalRole: nextOperationalRole,
      chatwootAgentId: nextAgentId,
      visibilityScope: nextVisibilityScope,
    },
  });
  return listUsers(organizationId).find((user) => user.id === userId);
}

function syncTaskFromAttributes({ organizationId, conversationId, attributes, actorUserId }) {
  const title = String(attributes?.crm_next_task || "").trim();
  const existing = db.prepare(
    "SELECT * FROM crm_tasks WHERE organization_id = ? AND conversation_id = ?"
  ).get(organizationId, conversationId);
  if (!title) {
    if (existing) db.prepare("DELETE FROM crm_tasks WHERE id = ?").run(existing.id);
    return null;
  }
  const dueDate = attributes.crm_task_due_at || null;
  const completedAt = attributes.crm_task_completed_at || null;
  let status = String(attributes.crm_task_done).toLowerCase() === "true" || attributes.crm_task_done === true
    ? "done"
    : "pending";
  if (status !== "done" && dueDate) {
    const due = new Date(`${dueDate}T23:59:59`);
    if (Number.isFinite(due.getTime()) && due.getTime() < Date.now()) status = "overdue";
  }
  const now = nowIso();
  if (existing) {
    db.prepare(`
      UPDATE crm_tasks SET title = ?, due_date = ?, status = ?, completed_at = ?,
      updated_by_user_id = ?, updated_at = ? WHERE id = ?
    `).run(title, dueDate, status, completedAt, actorUserId, now, existing.id);
    return existing.id;
  }
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO crm_tasks
    (id, organization_id, conversation_id, title, due_date, status, completed_at,
     created_by_user_id, updated_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, organizationId, conversationId, title, dueDate, status, completedAt, actorUserId, actorUserId, now, now);
  return id;
}

function conversationLabelNames(conversation) {
  const labels = conversation?.labels || conversation?.label_list || [];
  if (!Array.isArray(labels)) return [];
  return [...new Set(labels.map((label) => String(label?.title || label?.name || label || "").trim()).filter(Boolean))];
}

function conversationAssigneeId(conversation) {
  const raw =
    conversation?.meta?.assignee?.id ??
    conversation?.assignee?.id ??
    conversation?.assignee_id ??
    null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function interventionLabelsForConversation(conversation) {
  const interventionKeys = new Set(["precisa-humano", "atendimento-manual"]);
  return conversationLabelNames(conversation).filter((label) =>
    interventionKeys.has(String(label).toLocaleLowerCase("pt-BR"))
  );
}

function syncInterventions({ organizationId, conversations }) {
  const now = nowIso();
  const seen = new Set();
  const activeRows = db.prepare(
    "SELECT * FROM interventions WHERE organization_id = ? AND status != 'resolved'"
  ).all(organizationId);
  const activeByConversation = new Map(activeRows.map((row) => [Number(row.conversation_id), row]));
  const upsert = db.prepare(`
    INSERT INTO interventions
    (id, organization_id, conversation_id, status, trigger_labels_json, assignee_agent_id,
     first_detected_at, last_detected_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(organization_id, conversation_id) DO UPDATE SET
      status = excluded.status,
      trigger_labels_json = excluded.trigger_labels_json,
      assignee_agent_id = excluded.assignee_agent_id,
      last_detected_at = excluded.last_detected_at,
      resolved_by_user_id = NULL,
      resolved_at = NULL,
      updated_at = excluded.updated_at
  `);

  for (const conversation of Array.isArray(conversations) ? conversations : []) {
    const labels = interventionLabelsForConversation(conversation);
    if (!labels.length) continue;
    const conversationId = Number(conversation.id);
    if (!Number.isInteger(conversationId) || conversationId <= 0) continue;
    seen.add(conversationId);
    const status = labels.some((label) => String(label).toLocaleLowerCase("pt-BR") === "atendimento-manual")
      ? "assumed"
      : "open";
    const previous = activeByConversation.get(conversationId);
    upsert.run(
      previous?.id || crypto.randomUUID(),
      organizationId,
      conversationId,
      status,
      JSON.stringify(labels),
      conversationAssigneeId(conversation),
      previous?.first_detected_at || now,
      now,
      now
    );
    if (!previous) {
      logAudit({
        organizationId,
        action: "intervention.detected",
        entityType: "conversation",
        entityId: conversationId,
        after: { labels, status },
      });
    }
  }

  for (const row of activeRows) {
    const conversationId = Number(row.conversation_id);
    if (seen.has(conversationId)) continue;
    db.prepare(`
      UPDATE interventions
      SET status = 'resolved', resolved_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, row.id);
    logAudit({
      organizationId,
      action: "intervention.auto_resolved",
      entityType: "conversation",
      entityId: conversationId,
      before: { status: row.status, labels: safeJsonParse(row.trigger_labels_json, []) },
      after: { status: "resolved" },
    });
  }
}

function markInterventionAssumed({ organizationId, conversationId, actorUserId, agentId, labels }) {
  const now = nowIso();
  const existing = db.prepare(
    "SELECT * FROM interventions WHERE organization_id = ? AND conversation_id = ?"
  ).get(organizationId, conversationId);
  db.prepare(`
    INSERT INTO interventions
    (id, organization_id, conversation_id, status, trigger_labels_json, assignee_agent_id,
     first_detected_at, last_detected_at, assumed_by_user_id, assumed_at, updated_at)
    VALUES (?, ?, ?, 'assumed', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(organization_id, conversation_id) DO UPDATE SET
      status = 'assumed',
      trigger_labels_json = excluded.trigger_labels_json,
      assignee_agent_id = excluded.assignee_agent_id,
      last_detected_at = excluded.last_detected_at,
      assumed_by_user_id = excluded.assumed_by_user_id,
      assumed_at = excluded.assumed_at,
      resolved_by_user_id = NULL,
      resolved_at = NULL,
      updated_at = excluded.updated_at
  `).run(
    existing?.id || crypto.randomUUID(),
    organizationId,
    conversationId,
    JSON.stringify(labels || ["atendimento-manual"]),
    agentId || null,
    existing?.first_detected_at || now,
    now,
    actorUserId,
    now,
    now
  );
  logAudit({
    organizationId,
    actorUserId,
    action: "intervention.assumed",
    entityType: "conversation",
    entityId: conversationId,
    before: existing ? { status: existing.status } : null,
    after: { status: "assumed", agentId, labels },
  });
}

function markInterventionResolved({ organizationId, conversationId, actorUserId }) {
  const now = nowIso();
  const existing = db.prepare(
    "SELECT * FROM interventions WHERE organization_id = ? AND conversation_id = ?"
  ).get(organizationId, conversationId);
  if (existing) {
    db.prepare(`
      UPDATE interventions
      SET status = 'resolved', resolved_by_user_id = ?, resolved_at = ?, updated_at = ?
      WHERE id = ?
    `).run(actorUserId, now, now, existing.id);
  }
  logAudit({
    organizationId,
    actorUserId,
    action: "intervention.resolved",
    entityType: "conversation",
    entityId: conversationId,
    before: existing ? { status: existing.status, labels: safeJsonParse(existing.trigger_labels_json, []) } : null,
    after: { status: "resolved" },
  });
}


function touchPresence({ organizationId, userId, path: requestPath = null, action = false }) {
  if (!organizationId || !userId) return null;
  const now = nowIso();
  db.prepare(`
    INSERT INTO user_presence
    (user_id, organization_id, last_seen_at, last_action_at, last_path, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, organization_id) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      last_action_at = CASE
        WHEN ? = 1 THEN excluded.last_action_at
        ELSE user_presence.last_action_at
      END,
      last_path = COALESCE(excluded.last_path, user_presence.last_path),
      updated_at = excluded.updated_at
  `).run(
    userId,
    organizationId,
    now,
    now,
    requestPath ? String(requestPath).slice(0, 240) : null,
    now,
    action ? 1 : 0
  );
  return now;
}

function presenceStatus(lastSeenAt, referenceMs = Date.now()) {
  const timestamp = Date.parse(lastSeenAt || "");
  if (!Number.isFinite(timestamp)) return "offline";
  const elapsed = referenceMs - timestamp;
  if (elapsed <= 2 * 60 * 1000) return "online";
  if (elapsed <= 10 * 60 * 1000) return "away";
  return "offline";
}

function listPresence(organizationId, referenceMs = Date.now()) {
  return db.prepare(`
    SELECT u.id AS user_id, u.name, u.email, u.active,
           m.operational_role, m.chatwoot_agent_id,
           p.last_seen_at, p.last_action_at, p.last_path
    FROM users u
    JOIN memberships m ON m.user_id = u.id AND m.organization_id = ?
    LEFT JOIN user_presence p ON p.user_id = u.id AND p.organization_id = m.organization_id
    WHERE u.active = 1
    ORDER BY u.name
  `).all(organizationId).map((row) => ({
    userId: row.user_id,
    name: row.name,
    email: row.email,
    operationalRole: normalizeOperationalProfile(row.operational_role),
    chatwootAgentId: row.chatwoot_agent_id ? Number(row.chatwoot_agent_id) : null,
    lastSeenAt: row.last_seen_at || null,
    lastActionAt: row.last_action_at || null,
    lastPath: row.last_path || null,
    status: presenceStatus(row.last_seen_at, referenceMs),
  }));
}

function listOperationalUsers(organizationId, options = {}) {
  const roles = Array.isArray(options.roles) ? options.roles : [];
  const users = listUsers(organizationId).filter((user) => user.active && user.chatwootAgentId);
  return roles.length
    ? users.filter((user) => roles.includes(user.operationalRole))
    : users;
}

function getOperationalUserByAgentId(organizationId, agentId) {
  const parsed = Number(agentId);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return listOperationalUsers(organizationId).find(
    (user) => Number(user.chatwootAgentId) === parsed
  ) || null;
}

function archiveOpportunity({ organizationId, conversationId, actorUserId, reason, note = "" }) {
  const parsedConversationId = Number(conversationId);
  if (!Number.isInteger(parsedConversationId) || parsedConversationId <= 0) {
    const error = new Error("Conversa inválida");
    error.status = 400;
    throw error;
  }
  const cleanReason = String(reason || "").trim().slice(0, 120);
  if (!cleanReason) {
    const error = new Error("Informe o motivo do arquivamento");
    error.status = 400;
    throw error;
  }
  const now = nowIso();
  const existing = db.prepare(`
    SELECT * FROM archived_opportunities
    WHERE organization_id = ? AND conversation_id = ?
  `).get(organizationId, parsedConversationId);
  db.prepare(`
    INSERT INTO archived_opportunities
    (id, organization_id, conversation_id, reason, note, archived_by_user_id,
     archived_at, restored_by_user_id, restored_at, active, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?)
    ON CONFLICT(organization_id, conversation_id) DO UPDATE SET
      reason = excluded.reason,
      note = excluded.note,
      archived_by_user_id = excluded.archived_by_user_id,
      archived_at = excluded.archived_at,
      restored_by_user_id = NULL,
      restored_at = NULL,
      active = 1,
      updated_at = excluded.updated_at
  `).run(
    existing?.id || crypto.randomUUID(),
    organizationId,
    parsedConversationId,
    cleanReason,
    String(note || "").trim().slice(0, 500) || null,
    actorUserId || null,
    now,
    now
  );
  logAudit({
    organizationId,
    actorUserId,
    action: "opportunity.archived",
    entityType: "conversation",
    entityId: parsedConversationId,
    before: existing && existing.active ? { archived: true, reason: existing.reason } : { archived: false },
    after: { archived: true, reason: cleanReason, note: String(note || "").trim() || null },
  });
  return getArchivedOpportunity(organizationId, parsedConversationId);
}

function restoreOpportunity({ organizationId, conversationId, actorUserId }) {
  const parsedConversationId = Number(conversationId);
  const current = db.prepare(`
    SELECT * FROM archived_opportunities
    WHERE organization_id = ? AND conversation_id = ? AND active = 1
  `).get(organizationId, parsedConversationId);
  if (!current) return null;
  const now = nowIso();
  db.prepare(`
    UPDATE archived_opportunities
    SET active = 0, restored_by_user_id = ?, restored_at = ?, updated_at = ?
    WHERE id = ?
  `).run(actorUserId || null, now, now, current.id);
  logAudit({
    organizationId,
    actorUserId,
    action: "opportunity.restored",
    entityType: "conversation",
    entityId: parsedConversationId,
    before: { archived: true, reason: current.reason },
    after: { archived: false },
  });
  return { conversationId: parsedConversationId, restoredAt: now };
}

function getArchivedOpportunity(organizationId, conversationId) {
  const row = db.prepare(`
    SELECT a.*, u.name AS archived_by_name, r.name AS restored_by_name
    FROM archived_opportunities a
    LEFT JOIN users u ON u.id = a.archived_by_user_id
    LEFT JOIN users r ON r.id = a.restored_by_user_id
    WHERE a.organization_id = ? AND a.conversation_id = ? AND a.active = 1
  `).get(organizationId, Number(conversationId));
  if (!row) return null;
  return {
    id: row.id,
    conversationId: Number(row.conversation_id),
    reason: row.reason,
    note: row.note || "",
    archivedByUserId: row.archived_by_user_id || null,
    archivedByName: row.archived_by_name || "Sistema",
    archivedAt: row.archived_at,
    active: Boolean(row.active),
  };
}

function listArchivedOpportunities(organizationId) {
  return db.prepare(`
    SELECT a.*, u.name AS archived_by_name
    FROM archived_opportunities a
    LEFT JOIN users u ON u.id = a.archived_by_user_id
    WHERE a.organization_id = ? AND a.active = 1
    ORDER BY a.archived_at DESC
  `).all(organizationId).map((row) => ({
    id: row.id,
    conversationId: Number(row.conversation_id),
    reason: row.reason,
    note: row.note || "",
    archivedByUserId: row.archived_by_user_id || null,
    archivedByName: row.archived_by_name || "Sistema",
    archivedAt: row.archived_at,
    active: Boolean(row.active),
  }));
}

function archivedConversationIds(organizationId) {
  return new Set(
    listArchivedOpportunities(organizationId).map((item) => Number(item.conversationId))
  );
}

function createTransferRequest({
  organizationId,
  conversationId,
  requestedByUserId,
  reason,
  previousAgentId = null,
}) {
  const parsedConversationId = Number(conversationId);
  const cleanReason = String(reason || "").trim().slice(0, 500);
  if (!Number.isInteger(parsedConversationId) || parsedConversationId <= 0 || !cleanReason) {
    const error = new Error("Conversa e motivo são obrigatórios");
    error.status = 400;
    throw error;
  }
  const existing = db.prepare(`
    SELECT * FROM transfer_requests
    WHERE organization_id = ? AND conversation_id = ? AND status = 'pending'
    ORDER BY created_at DESC LIMIT 1
  `).get(organizationId, parsedConversationId);
  if (existing) {
    const error = new Error("Já existe uma solicitação pendente para esta oportunidade");
    error.status = 409;
    throw error;
  }
  const id = crypto.randomUUID();
  const now = nowIso();
  db.prepare(`
    INSERT INTO transfer_requests
    (id, organization_id, conversation_id, requested_by_user_id, request_type,
     reason, previous_agent_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'redistribution', ?, ?, 'pending', ?, ?)
  `).run(
    id,
    organizationId,
    parsedConversationId,
    requestedByUserId,
    cleanReason,
    Number(previousAgentId) || null,
    now,
    now
  );
  logAudit({
    organizationId,
    actorUserId: requestedByUserId,
    action: "transfer.requested",
    entityType: "conversation",
    entityId: parsedConversationId,
    after: { requestId: id, reason: cleanReason, previousAgentId: Number(previousAgentId) || null },
  });
  return getTransferRequest(organizationId, id);
}

function getTransferRequest(organizationId, requestId) {
  const row = db.prepare(`
    SELECT t.*, requester.name AS requester_name, resolver.name AS resolver_name
    FROM transfer_requests t
    JOIN users requester ON requester.id = t.requested_by_user_id
    LEFT JOIN users resolver ON resolver.id = t.resolved_by_user_id
    WHERE t.organization_id = ? AND t.id = ?
  `).get(organizationId, requestId);
  if (!row) return null;
  return {
    id: row.id,
    conversationId: Number(row.conversation_id),
    requestedByUserId: row.requested_by_user_id,
    requesterName: row.requester_name,
    requestType: row.request_type,
    reason: row.reason,
    previousAgentId: row.previous_agent_id ? Number(row.previous_agent_id) : null,
    targetAgentId: row.target_agent_id ? Number(row.target_agent_id) : null,
    status: row.status,
    resolvedByUserId: row.resolved_by_user_id || null,
    resolverName: row.resolver_name || null,
    resolutionNote: row.resolution_note || "",
    createdAt: row.created_at,
    resolvedAt: row.resolved_at || null,
  };
}

function listTransferRequests(organizationId, status = "pending") {
  const normalizedStatus = ["pending", "approved", "rejected", "cancelled", "all"].includes(status)
    ? status
    : "pending";
  const rows = normalizedStatus === "all"
    ? db.prepare(`
        SELECT t.id FROM transfer_requests t
        WHERE t.organization_id = ?
        ORDER BY t.created_at DESC LIMIT 200
      `).all(organizationId)
    : db.prepare(`
        SELECT t.id FROM transfer_requests t
        WHERE t.organization_id = ? AND t.status = ?
        ORDER BY t.created_at DESC LIMIT 200
      `).all(organizationId, normalizedStatus);
  return rows.map((row) => getTransferRequest(organizationId, row.id));
}

function resolveTransferRequest({
  organizationId,
  requestId,
  actorUserId,
  status,
  targetAgentId = null,
  resolutionNote = "",
}) {
  const current = getTransferRequest(organizationId, requestId);
  if (!current) return null;
  if (current.status !== "pending") {
    const error = new Error("Esta solicitação já foi finalizada");
    error.status = 409;
    throw error;
  }
  const nextStatus = status === "approved" ? "approved" : "rejected";
  const now = nowIso();
  db.prepare(`
    UPDATE transfer_requests
    SET status = ?, target_agent_id = ?, resolved_by_user_id = ?,
        resolution_note = ?, resolved_at = ?, updated_at = ?
    WHERE id = ? AND organization_id = ?
  `).run(
    nextStatus,
    nextStatus === "approved" ? Number(targetAgentId) || null : null,
    actorUserId || null,
    String(resolutionNote || "").trim().slice(0, 500) || null,
    now,
    now,
    requestId,
    organizationId
  );
  logAudit({
    organizationId,
    actorUserId,
    action: nextStatus === "approved" ? "transfer.approved" : "transfer.rejected",
    entityType: "conversation",
    entityId: current.conversationId,
    before: { requestId, status: current.status },
    after: {
      requestId,
      status: nextStatus,
      targetAgentId: nextStatus === "approved" ? Number(targetAgentId) || null : null,
      resolutionNote: String(resolutionNote || "").trim() || null,
    },
  });
  return getTransferRequest(organizationId, requestId);
}

function logDirectHandoff({
  organizationId,
  actorUserId,
  conversationId,
  action,
  reason,
  previousAgentId,
  targetAgentId,
  stageBefore = null,
  stageAfter = null,
}) {
  logAudit({
    organizationId,
    actorUserId,
    action: "handoff.completed",
    entityType: "conversation",
    entityId: conversationId,
    before: { assigneeAgentId: Number(previousAgentId) || null, stage: stageBefore },
    after: { assigneeAgentId: Number(targetAgentId) || null, stage: stageAfter },
    metadata: { action, reason: String(reason || "").trim() },
  });
}

function tutorialRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    youtubeVideoId: row.youtube_video_id,
    youtubeUrl: row.youtube_url,
    title: row.title,
    description: row.description || "",
    category: row.category || "Geral",
    displayOrder: Number(row.display_order) || 0,
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listTutorialVideos(organizationId, options = {}) {
  const includeInactive = options.includeInactive === true;
  const rows = db.prepare(`
    SELECT *
    FROM tutorial_videos
    WHERE organization_id = ?
      AND (? = 1 OR active = 1)
    ORDER BY display_order ASC, title COLLATE NOCASE ASC, created_at ASC
  `).all(organizationId, includeInactive ? 1 : 0);
  return rows.map(tutorialRow);
}

function createTutorialVideo({
  organizationId,
  actorUserId,
  youtubeVideoId,
  youtubeUrl,
  title,
  description = "",
  category = "Geral",
  displayOrder = 0,
  active = true,
}) {
  const id = crypto.randomUUID();
  const now = nowIso();
  try {
    db.prepare(`
      INSERT INTO tutorial_videos
      (id, organization_id, youtube_video_id, youtube_url, title, description, category,
       display_order, active, created_by_user_id, updated_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      organizationId,
      youtubeVideoId,
      youtubeUrl,
      title,
      description || null,
      category || "Geral",
      Number(displayOrder) || 0,
      active ? 1 : 0,
      actorUserId || null,
      actorUserId || null,
      now,
      now
    );
  } catch (error) {
    if (String(error?.message || "").includes("UNIQUE constraint failed")) {
      const duplicate = new Error("Este vídeo já está cadastrado nos Tutoriais");
      duplicate.status = 409;
      throw duplicate;
    }
    throw error;
  }
  const created = db.prepare("SELECT * FROM tutorial_videos WHERE id = ?").get(id);
  logAudit({
    organizationId,
    actorUserId,
    action: "tutorial.created",
    entityType: "tutorial_video",
    entityId: id,
    after: tutorialRow(created),
  });
  return tutorialRow(created);
}

function updateTutorialVideo({
  organizationId,
  actorUserId,
  tutorialId,
  youtubeVideoId,
  youtubeUrl,
  title,
  description = "",
  category = "Geral",
  displayOrder = 0,
  active = true,
}) {
  const current = db.prepare(
    "SELECT * FROM tutorial_videos WHERE id = ? AND organization_id = ?"
  ).get(tutorialId, organizationId);
  if (!current) return null;
  const before = tutorialRow(current);
  try {
    db.prepare(`
      UPDATE tutorial_videos
      SET youtube_video_id = ?, youtube_url = ?, title = ?, description = ?, category = ?,
          display_order = ?, active = ?, updated_by_user_id = ?, updated_at = ?
      WHERE id = ? AND organization_id = ?
    `).run(
      youtubeVideoId,
      youtubeUrl,
      title,
      description || null,
      category || "Geral",
      Number(displayOrder) || 0,
      active ? 1 : 0,
      actorUserId || null,
      nowIso(),
      tutorialId,
      organizationId
    );
  } catch (error) {
    if (String(error?.message || "").includes("UNIQUE constraint failed")) {
      const duplicate = new Error("Este vídeo já está cadastrado nos Tutoriais");
      duplicate.status = 409;
      throw duplicate;
    }
    throw error;
  }
  const updated = db.prepare("SELECT * FROM tutorial_videos WHERE id = ?").get(tutorialId);
  logAudit({
    organizationId,
    actorUserId,
    action: "tutorial.updated",
    entityType: "tutorial_video",
    entityId: tutorialId,
    before,
    after: tutorialRow(updated),
  });
  return tutorialRow(updated);
}

function deleteTutorialVideo({ organizationId, actorUserId, tutorialId }) {
  const current = db.prepare(
    "SELECT * FROM tutorial_videos WHERE id = ? AND organization_id = ?"
  ).get(tutorialId, organizationId);
  if (!current) return false;
  db.prepare("DELETE FROM tutorial_videos WHERE id = ? AND organization_id = ?")
    .run(tutorialId, organizationId);
  logAudit({
    organizationId,
    actorUserId,
    action: "tutorial.deleted",
    entityType: "tutorial_video",
    entityId: tutorialId,
    before: tutorialRow(current),
  });
  return true;
}

function closeDatabase() {
  db.close();
}

function logAudit({ organizationId, actorUserId = null, action, entityType, entityId = null, before = null, after = null, metadata = null }) {
  db.prepare(`
    INSERT INTO audit_logs
    (id, organization_id, actor_user_id, action, entity_type, entity_id, before_json, after_json, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    organizationId,
    actorUserId,
    action,
    entityType,
    entityId ? String(entityId) : null,
    before === null ? null : JSON.stringify(before),
    after === null ? null : JSON.stringify(after),
    metadata === null ? null : JSON.stringify(metadata),
    nowIso()
  );
}

function listAudit(organizationId, limit = 50) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  return db.prepare(`
    SELECT a.id, a.action, a.entity_type, a.entity_id, a.before_json, a.after_json,
           a.metadata_json, a.created_at, u.name AS actor_name, u.email AS actor_email
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.actor_user_id
    WHERE a.organization_id = ?
    ORDER BY a.created_at DESC
    LIMIT ?
  `).all(organizationId, safeLimit).map((row) => ({
    id: row.id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    before: safeJsonParse(row.before_json),
    after: safeJsonParse(row.after_json),
    metadata: safeJsonParse(row.metadata_json),
    createdAt: row.created_at,
    actorName: row.actor_name || "Sistema",
    actorEmail: row.actor_email || null,
  }));
}

module.exports = {
  DEFAULT_STAGES,
  ROLE_PERMISSIONS,
  OPERATIONAL_PROFILES,
  databasePath,
  bootstrapFromEnv,
  authenticate,
  createSession,
  getSession,
  deleteSession,
  cleanupSessions,
  sessionPayload,
  getDefaultPipeline,
  replacePipelineStages,
  listFilterPresets,
  createFilterPreset,
  deleteFilterPreset,
  listUsers,
  createUser,
  updateUser,
  syncTaskFromAttributes,
  syncInterventions,
  markInterventionAssumed,
  markInterventionResolved,
  touchPresence,
  listPresence,
  listOperationalUsers,
  getOperationalUserByAgentId,
  archiveOpportunity,
  restoreOpportunity,
  getArchivedOpportunity,
  listArchivedOpportunities,
  archivedConversationIds,
  createTransferRequest,
  getTransferRequest,
  listTransferRequests,
  resolveTransferRequest,
  logDirectHandoff,
  listTutorialVideos,
  createTutorialVideo,
  updateTutorialVideo,
  deleteTutorialVideo,
  logAudit,
  listAudit,
  closeDatabase,
};
