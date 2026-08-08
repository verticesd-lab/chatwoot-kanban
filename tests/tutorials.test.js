const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-tutorials-test-"));
process.env.CRM_DB_PATH = path.join(tempDir, "crm.sqlite");
process.env.CRM_ENCRYPTION_KEY = "chave-de-teste-com-mais-de-24-caracteres";
process.env.CRM_ORGANIZATION_NAME = "Loja Tutorial";
process.env.CRM_ADMIN_NAME = "Administrador";
process.env.CRM_ADMIN_EMAIL = "admin-tutorial@example.com";
process.env.CRM_ADMIN_PASSWORD = "senha-segura-123";
process.env.CHATWOOT_ACCOUNT_ID = "4";
process.env.CHATWOOT_API_TOKEN = "token-chatwoot-teste";

const db = require("../src/db");

try {
  db.bootstrapFromEnv("https://chat.example.com");
  const admin = db.authenticate("admin-tutorial@example.com", "senha-segura-123");
  const sessionToken = db.createSession(admin, 60_000);
  const session = db.getSession(sessionToken.rawToken);
  assert(session.permissions.includes("tutorials:manage"));

  const created = db.createTutorialVideo({
    organizationId: session.organization_id,
    actorUserId: session.user_id,
    youtubeVideoId: "dQw4w9WgXcQ",
    youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title: "Primeiros passos",
    description: "Apresentação rápida do CRM",
    category: "Geral",
    displayOrder: 2,
    active: true,
  });
  assert(created.id);
  assert.strictEqual(created.active, true);
  assert.strictEqual(created.displayOrder, 2);

  const active = db.listTutorialVideos(session.organization_id);
  assert.strictEqual(active.length, 1);
  assert.strictEqual(active[0].title, "Primeiros passos");

  const updated = db.updateTutorialVideo({
    organizationId: session.organization_id,
    actorUserId: session.user_id,
    tutorialId: created.id,
    youtubeVideoId: "dQw4w9WgXcQ",
    youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title: "Primeiros passos atualizados",
    description: "Atualizado",
    category: "Onboarding",
    displayOrder: 1,
    active: false,
  });
  assert.strictEqual(updated.active, false);
  assert.strictEqual(db.listTutorialVideos(session.organization_id).length, 0);
  assert.strictEqual(db.listTutorialVideos(session.organization_id, { includeInactive: true }).length, 1);

  const audit = db.listAudit(session.organization_id, 50);
  assert(audit.some((entry) => entry.action === "tutorial.created"));
  assert(audit.some((entry) => entry.action === "tutorial.updated"));

  assert.strictEqual(db.deleteTutorialVideo({
    organizationId: session.organization_id,
    actorUserId: session.user_id,
    tutorialId: created.id,
  }), true);
  assert.strictEqual(db.listTutorialVideos(session.organization_id, { includeInactive: true }).length, 0);

  console.log("CRM V1.3.4 tutorial foundation tests: OK");
} finally {
  db.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
