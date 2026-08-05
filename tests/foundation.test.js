const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-v13-test-"));
process.env.CRM_DB_PATH = path.join(tempDir, "crm.sqlite");
process.env.CRM_ENCRYPTION_KEY = "chave-de-teste-com-mais-de-24-caracteres";
process.env.CRM_ORGANIZATION_NAME = "Loja Piloto";
process.env.CRM_ADMIN_NAME = "Administrador";
process.env.CRM_ADMIN_EMAIL = "admin@example.com";
process.env.CRM_ADMIN_PASSWORD = "senha-segura-123";
process.env.CHATWOOT_ACCOUNT_ID = "4";
process.env.CHATWOOT_API_TOKEN = "token-chatwoot-teste";

const db = require("../src/db");

try {
  const bootstrap = db.bootstrapFromEnv("https://chat.example.com");
  assert.strictEqual(bootstrap.bootstrapped, true);

  const admin = db.authenticate("ADMIN@example.com", "senha-segura-123");
  assert(admin, "admin deve autenticar");
  assert.strictEqual(admin.role, "admin");

  const createdSession = db.createSession(admin, 60_000);
  const session = db.getSession(createdSession.rawToken);
  assert(session, "sessão deve ser recuperada");
  assert.strictEqual(session.chatwootToken, "token-chatwoot-teste");
  assert(session.permissions.includes("users:manage"));

  const pipeline = db.getDefaultPipeline(session.organization_id);
  assert.strictEqual(pipeline.stages.length, 7);
  assert.strictEqual(pipeline.stages[0].id, "new");

  const reordered = [...pipeline.stages];
  const contacted = reordered.splice(1, 1)[0];
  reordered.splice(2, 0, contacted);
  const savedStages = db.replacePipelineStages(
    session.organization_id,
    reordered,
    session.user_id
  );
  assert.strictEqual(savedStages[2].id, "contacted");

  const filter = db.createFilterPreset({
    organizationId: session.organization_id,
    userId: session.user_id,
    name: "Urgentes",
    scope: "shared",
    snapshot: { search: "", filters: { priority: "urgent" } },
  });
  assert.strictEqual(filter.scope, "shared");
  assert.strictEqual(db.listFilterPresets(session.organization_id, session.user_id).length, 1);

  const user = db.createUser({
    organizationId: session.organization_id,
    actorUserId: session.user_id,
    name: "Vendedor Teste",
    email: "vendedor@example.com",
    password: "senha-vendedor-123",
    role: "agent",
  });
  assert.strictEqual(user.role, "agent");
  assert(db.authenticate("vendedor@example.com", "senha-vendedor-123"));

  db.syncTaskFromAttributes({
    organizationId: session.organization_id,
    conversationId: 243,
    attributes: {
      crm_next_task: "Retornar cliente",
      crm_task_due_at: "2099-12-31",
      crm_task_done: false,
    },
    actorUserId: session.user_id,
  });

  const audit = db.listAudit(session.organization_id, 100);
  assert(audit.some((entry) => entry.action === "pipeline.stages.updated"));
  assert(audit.some((entry) => entry.action === "user.created"));

  db.deleteSession(createdSession.rawToken);
  assert.strictEqual(db.getSession(createdSession.rawToken), null);

  console.log("CRM V1.3 central foundation tests: OK");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
