const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const reactivation = require("../src/reactivation");

assert.strictEqual(
  reactivation.normalizeLabel("Reativação Única Enviada"),
  "reativacao-unica-enviada"
);
assert.strictEqual(
  reactivation.normalizeLabel("aguardando cpf de terceiros"),
  "aguardando-cpf-de-terceiros"
);

const config = reactivation.reactivationConfig({
  REACTIVATION_SEND_ENABLED: "false",
  REACTIVATION_ELIGIBLE_LABELS:
    "aguardando cpf de terceiros,fora-do-horario,aguardando-retorno-do-cliente",
  REACTIVATION_BLOCK_LABEL: "Reativação Única Enviada",
});
assert.strictEqual(config.sendEnabled, false);
assert.deepStrictEqual(config.eligibleLabels, [
  "aguardando-cpf-de-terceiros",
  "fora-do-horario",
  "aguardando-retorno-do-cliente",
]);
assert.strictEqual(config.blockLabel, "reativacao-unica-enviada");

const conversation = {
  id: 501,
  labels: ["Fora do Horário"],
  custom_attributes: { crm_stage: "qualification" },
  meta: { sender: { id: 88, name: "Maria da Silva", phone_number: "+55 47 99999-0000" } },
  last_activity_at: Math.floor(Date.now() / 1000),
};
const snapshot = reactivation.candidateSnapshot(conversation, config);
assert.deepStrictEqual(snapshot.matchedLabels, ["fora-do-horario"]);
assert.strictEqual(snapshot.hasBlockLabel, false);
assert.strictEqual(snapshot.terminal, false);
assert.strictEqual(
  reactivation.renderMessage("Oi, {{primeiro_nome}}! Vamos retomar?", conversation),
  "Oi, Maria! Vamos retomar?"
);
assert.throws(
  () => reactivation.validateMessageTemplate("Oi {{cpf}}"),
  /Variável não suportada/
);

const incomingConversation = {
  last_non_activity_message: {
    message_type: "incoming",
    created_at: Math.floor(Date.now() / 1000),
  },
};
assert(reactivation.latestIncomingAfter(incomingConversation, new Date(Date.now() - 5000).toISOString()));

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-reactivation-test-"));
process.env.CRM_DB_PATH = path.join(tempDir, "crm.sqlite");
process.env.CRM_ENCRYPTION_KEY = "chave-de-teste-com-mais-de-24-caracteres";
process.env.CRM_ORGANIZATION_NAME = "Loja Reativacao";
process.env.CRM_ADMIN_NAME = "Administrador";
process.env.CRM_ADMIN_EMAIL = "admin-reactivation@example.com";
process.env.CRM_ADMIN_PASSWORD = "senha-segura-123";
process.env.CHATWOOT_ACCOUNT_ID = "4";
process.env.CHATWOOT_API_TOKEN = "token-chatwoot-teste";

const db = require("../src/db");
try {
  db.bootstrapFromEnv("https://chat.example.com");
  const admin = db.authenticate("admin-reactivation@example.com", "senha-segura-123");
  const campaign = db.createReactivationCampaign({
    organizationId: admin.organization_id,
    actorUserId: admin.id,
    name: "Retomada teste",
    templateKey: "general",
    messageTemplate: "Oi, {{primeiro_nome}}!",
    recipients: [
      {
        conversationId: 501,
        contactId: 88,
        contactName: "Maria da Silva",
        phone: "+5547999990000",
        sourceType: "tag",
        sourceLabels: ["fora-do-horario"],
        messageRendered: "Oi, Maria!",
        status: "queued",
      },
      {
        conversationId: 502,
        contactName: "Bloqueado",
        sourceType: "manual",
        sourceLabels: [],
        messageRendered: "Oi!",
        status: "blocked",
        blockReason: "Reativação única já enviada anteriormente",
      },
    ],
  });
  assert.strictEqual(campaign.counts.total, 2);
  assert.strictEqual(campaign.counts.queued, 1);
  assert.strictEqual(campaign.counts.blocked, 1);

  const claimed = db.claimNextReactivationRecipient();
  assert(claimed, "destinatário deve ser reivindicado pela fila");
  assert.strictEqual(claimed.status, "processing");
  assert.strictEqual(claimed.conversationId, 501);
  assert.strictEqual(
    db.getReactivationProtectionStatus(admin.organization_id, 501, claimed.id),
    null,
    "o próprio item em processamento não pode se autobloquear"
  );

  db.markReactivationRecipientSent({ recipientId: claimed.id, externalMessageId: "msg-1" });
  assert.strictEqual(db.hasPriorSuccessfulReactivation(admin.organization_id, 501), true);
  assert.strictEqual(db.getReactivationProtectionStatus(admin.organization_id, 501), "sent");

  const replyChanges = db.markReactivationReply({
    organizationId: admin.organization_id,
    conversationId: 501,
    repliedAt: new Date().toISOString(),
  });
  assert.strictEqual(replyChanges, 1);
  const summary = db.reactivationSummary(admin.organization_id);
  assert.strictEqual(summary.sent, 1);
  assert.strictEqual(summary.replied, 1);
  assert.strictEqual(summary.responseRate, 100);

  const finalCampaign = db.getReactivationCampaign(admin.organization_id, campaign.id);
  assert.strictEqual(finalCampaign.status, "completed");
  assert.strictEqual(finalCampaign.counts.replied, 1);

  const audit = db.listAudit(admin.organization_id, 100);
  assert(audit.some((entry) => entry.action === "reactivation.campaign.created"));
} finally {
  db.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

console.log("CRM V1.3.6 reactivation center tests: OK");
