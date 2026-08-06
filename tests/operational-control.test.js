const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-v133-control-"));
process.env.CRM_DB_PATH = path.join(tempDir, "crm.sqlite");
process.env.CRM_ENCRYPTION_KEY = "chave-de-teste-v133-com-mais-de-24-caracteres";
process.env.CRM_ORGANIZATION_NAME = "VR Piloto";
process.env.CRM_ADMIN_NAME = "Administrador";
process.env.CRM_ADMIN_EMAIL = "admin-v133@example.com";
process.env.CRM_ADMIN_PASSWORD = "senha-segura-v133";
process.env.CHATWOOT_ACCOUNT_ID = "1";
process.env.CHATWOOT_API_TOKEN = "token-chatwoot-v133";

const db = require("../src/db");

try {
  db.bootstrapFromEnv("https://chat.example.com");
  const adminAuth = db.authenticate("admin-v133@example.com", "senha-segura-v133");
  assert(adminAuth, "administrador deve autenticar");
  const adminToken = db.createSession(adminAuth, 60_000);
  const adminSession = db.getSession(adminToken.rawToken);
  const organizationId = adminSession.organization_id;

  assert(adminSession.permissions.includes("archive:manage"));
  assert(adminSession.permissions.includes("transfer_requests:manage"));
  assert(adminSession.permissions.includes("presence:read"));

  const manager = db.createUser({
    organizationId,
    actorUserId: adminSession.user_id,
    name: "Gerente Piloto",
    email: "gerente-v133@example.com",
    password: "senha-gerente-v133",
    operationalRole: "manager",
    chatwootAgentId: 20,
    visibilityScope: "all",
  });
  const sdr = db.createUser({
    organizationId,
    actorUserId: adminSession.user_id,
    name: "SDR Piloto",
    email: "sdr-v133@example.com",
    password: "senha-sdr-v133",
    operationalRole: "sdr",
    chatwootAgentId: 21,
    visibilityScope: "unassigned_and_mine",
  });
  const seller = db.createUser({
    organizationId,
    actorUserId: adminSession.user_id,
    name: "Vendedor Piloto",
    email: "seller-v133@example.com",
    password: "senha-seller-v133",
    operationalRole: "seller",
    chatwootAgentId: 22,
    visibilityScope: "mine",
  });

  const managerToken = db.createSession(
    db.authenticate(manager.email, "senha-gerente-v133"),
    60_000
  );
  const sdrToken = db.createSession(db.authenticate(sdr.email, "senha-sdr-v133"), 60_000);
  const sellerToken = db.createSession(
    db.authenticate(seller.email, "senha-seller-v133"),
    60_000
  );
  const managerSession = db.getSession(managerToken.rawToken);
  const sdrSession = db.getSession(sdrToken.rawToken);
  const sellerSession = db.getSession(sellerToken.rawToken);

  assert(managerSession.permissions.includes("archive:manage"));
  assert(managerSession.permissions.includes("assignments:manage"));
  assert(!sdrSession.permissions.includes("assignments:manage"), "SDR deve usar handoff controlado");
  assert(sdrSession.permissions.includes("interventions:manage"));
  assert(!sellerSession.permissions.includes("assignments:manage"));
  assert(sellerSession.permissions.includes("interventions:manage"));

  const touchedAt = db.touchPresence({
    organizationId,
    userId: sellerSession.user_id,
    path: "pipeline",
    action: true,
  });
  let sellerPresence = db.listPresence(organizationId, Date.parse(touchedAt) + 30_000)
    .find((item) => item.userId === sellerSession.user_id);
  assert.strictEqual(sellerPresence.status, "online");
  assert.strictEqual(sellerPresence.lastPath, "pipeline");

  sellerPresence = db.listPresence(organizationId, Date.parse(touchedAt) + 3 * 60_000)
    .find((item) => item.userId === sellerSession.user_id);
  assert.strictEqual(sellerPresence.status, "away");

  sellerPresence = db.listPresence(organizationId, Date.parse(touchedAt) + 11 * 60_000)
    .find((item) => item.userId === sellerSession.user_id);
  assert.strictEqual(sellerPresence.status, "offline");

  const archived = db.archiveOpportunity({
    organizationId,
    conversationId: 501,
    actorUserId: managerSession.user_id,
    reason: "Lead de teste",
    note: "Arquivado durante validação local",
  });
  assert.strictEqual(archived.conversationId, 501);
  assert.strictEqual(archived.reason, "Lead de teste");
  assert(db.archivedConversationIds(organizationId).has(501));
  assert.strictEqual(db.listArchivedOpportunities(organizationId).length, 1);

  const restored = db.restoreOpportunity({
    organizationId,
    conversationId: 501,
    actorUserId: managerSession.user_id,
  });
  assert.strictEqual(restored.conversationId, 501);
  assert.strictEqual(db.getArchivedOpportunity(organizationId, 501), null);
  assert.strictEqual(db.listArchivedOpportunities(organizationId).length, 0);

  const request = db.createTransferRequest({
    organizationId,
    conversationId: 777,
    requestedByUserId: sellerSession.user_id,
    reason: "Lead atribuído por engano",
    previousAgentId: 22,
  });
  assert.strictEqual(request.status, "pending");
  assert.strictEqual(db.listTransferRequests(organizationId, "pending").length, 1);

  assert.throws(
    () => db.createTransferRequest({
      organizationId,
      conversationId: 777,
      requestedByUserId: sellerSession.user_id,
      reason: "Solicitação duplicada",
      previousAgentId: 22,
    }),
    (error) => error.status === 409
  );

  const resolved = db.resolveTransferRequest({
    organizationId,
    requestId: request.id,
    actorUserId: managerSession.user_id,
    status: "approved",
    targetAgentId: 21,
    resolutionNote: "Devolver para nova qualificação",
  });
  assert.strictEqual(resolved.status, "approved");
  assert.strictEqual(resolved.targetAgentId, 21);
  assert.strictEqual(db.listTransferRequests(organizationId, "pending").length, 0);

  db.logDirectHandoff({
    organizationId,
    actorUserId: sdrSession.user_id,
    conversationId: 778,
    action: "to_seller",
    reason: "Crédito aprovado",
    previousAgentId: 21,
    targetAgentId: 22,
    stageBefore: "qualification",
    stageAfter: "proposal",
  });

  const audit = db.listAudit(organizationId, 200);
  assert(audit.some((entry) => entry.action === "opportunity.archived"));
  assert(audit.some((entry) => entry.action === "opportunity.restored"));
  assert(audit.some((entry) => entry.action === "transfer.requested"));
  assert(audit.some((entry) => entry.action === "transfer.approved"));
  assert(audit.some((entry) => entry.action === "handoff.completed"));

  db.deleteSession(adminToken.rawToken);
  db.deleteSession(managerToken.rawToken);
  db.deleteSession(sdrToken.rawToken);
  db.deleteSession(sellerToken.rawToken);

  console.log("CRM V1.3.3 operational control tests: OK");
} finally {
  db.closeDatabase();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === 7) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    }
  }
}
