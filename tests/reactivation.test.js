const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const reactivation = require("../src/reactivation");

assert.strictEqual(
  reactivation.normalizeLabel("Reativação Única Enviada"),
  "reativacao-unica-enviada"
);
assert.strictEqual(reactivation.normalizeLabel("fora-do-horario"), "fora-de-horario");
assert.strictEqual(
  reactivation.normalizeLabel("aguardando-retorno-do-cliente"),
  "aguardando-retorno-cliente"
);
assert.strictEqual(
  reactivation.normalizeLabel("aguardando-cpf-de-terceiros"),
  "aguardando-cpf-terceiro"
);
assert.strictEqual(
  reactivation.normalizeLabel("aguardando cpf de terceiros"),
  "aguardando-cpf-terceiro"
);

const config = reactivation.reactivationConfig({
  REACTIVATION_SEND_ENABLED: "false",
  REACTIVATION_ELIGIBLE_LABELS:
    "aguardando cpf de terceiros,fora-de-horario,aguardando-retorno-cliente",
  REACTIVATION_BLOCK_LABEL: "Reativação Única Enviada",
});
assert.strictEqual(config.sendEnabled, false);
assert.deepStrictEqual(config.eligibleLabels, [
  "aguardando-cpf-terceiro",
  "fora-de-horario",
  "aguardando-retorno-cliente",
]);
assert.strictEqual(config.blockLabel, "reativacao-unica-enviada");

assert.strictEqual(
  reactivation.canonicalPhone("+55 65 9961-3366"),
  reactivation.canonicalPhone("+55 65 99961-3366"),
  "celular brasileiro legado com/sem nono dígito deve convergir para a mesma identidade"
);
assert.strictEqual(
  reactivation.canonicalPhone("+55 65 3222-3344"),
  "556532223344",
  "telefone fixo não deve receber nono dígito"
);

const conversation = {
  id: 501,
  labels: ["Fora do Horário"],
  custom_attributes: { crm_stage: "qualification" },
  meta: { sender: { id: 88, name: "Maria da Silva", phone_number: "+55 47 99999-0000" } },
  last_activity_at: Math.floor(Date.now() / 1000),
};
const snapshot = reactivation.candidateSnapshot(conversation, config);
assert.deepStrictEqual(snapshot.matchedLabels, ["fora-de-horario"]);
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
assert.strictEqual(
  reactivation.validateManualSourceReason("  Cliente pediu retorno  "),
  "Cliente pediu retorno"
);
assert.throws(
  () => reactivation.validateManualSourceReason(""),
  /motivo da inclusão manual/i
);

const incomingConversation = {
  last_non_activity_message: {
    message_type: "incoming",
    created_at: Math.floor(Date.now() / 1000),
  },
};
assert(reactivation.latestIncomingAfter(incomingConversation, new Date(Date.now() - 5000).toISOString()));

const incomingMessagesPayload = {
  messages: [
    {
      message_type: 0,
      created_at: Math.floor(Date.now() / 1000),
    },
  ],
};
assert(
  reactivation.latestIncomingAfter(
    incomingMessagesPayload,
    new Date(Date.now() - 5000).toISOString()
  ),
  "resposta incoming obtida pelo endpoint /messages deve ser reconhecida"
);


assert.strictEqual(reactivation.isIncomingMessage({ message_type: 0 }), true);
assert.strictEqual(reactivation.isIncomingMessage({ message_type: "incoming" }), true);
assert.strictEqual(reactivation.isIncomingMessage({ message_type: 1 }), false);
assert.strictEqual(
  reactivation.messageTimestampIso({ created_at: 1786325280 }),
  "2026-08-10T01:28:00.000Z"
);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-reactivation-test-"));
process.env.CRM_DB_PATH = path.join(tempDir, "crm.sqlite");
process.env.CRM_ENCRYPTION_KEY = "chave-de-teste-com-mais-de-24-caracteres";
process.env.CRM_ORGANIZATION_NAME = "Loja Reativacao";
process.env.CRM_ADMIN_NAME = "Administrador";
process.env.CRM_ADMIN_EMAIL = "admin-reactivation@example.com";
process.env.CRM_ADMIN_PASSWORD = "senha-segura-123";
process.env.CHATWOOT_ACCOUNT_ID = "4";
process.env.CHATWOOT_API_TOKEN = "token-chatwoot-teste";

// Simula upgrade de uma base V1.3.6.5 já existente: a inicialização precisa
// adicionar as novas colunas antes de criar o índice de identidade canônica.
const { DatabaseSync } = require("node:sqlite");
const legacyDb = new DatabaseSync(process.env.CRM_DB_PATH);
legacyDb.exec(`
  CREATE TABLE reactivation_recipients (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    conversation_id INTEGER NOT NULL,
    contact_id INTEGER,
    contact_name TEXT NOT NULL,
    phone TEXT,
    source_type TEXT NOT NULL DEFAULT 'tag',
    source_reason TEXT,
    source_labels_json TEXT NOT NULL DEFAULT '[]',
    message_rendered TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    block_reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    external_message_id TEXT,
    last_error TEXT,
    queued_at TEXT NOT NULL,
    processing_at TEXT,
    sent_at TEXT,
    failed_at TEXT,
    replied_at TEXT,
    reply_message_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (campaign_id, conversation_id)
  );
`);
legacyDb.close();

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
        phone: "+556599613366",
        canonicalPhone: reactivation.canonicalPhone("+556599613366"),
        sourceType: "tag",
        sourceLabels: ["fora-de-horario"],
        messageRendered: "Oi, Maria!",
        status: "queued",
      },
      {
        conversationId: 502,
        contactName: "Bloqueado",
        sourceType: "manual",
        sourceReason: "Solicitação do SDR/Gerente",
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
  const recipients = db.listReactivationRecipients(admin.organization_id, campaign.id);
  const manualRecipient = recipients.find((item) => item.conversationId === 502);
  assert(manualRecipient, "destinatário manual deve existir");
  assert.strictEqual(manualRecipient.sourceReason, "Solicitação do SDR/Gerente");

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
  const sameLegacyIdentity = {
    contactId: 114,
    canonicalPhone: reactivation.canonicalPhone("+5565999613366"),
  };
  assert.strictEqual(
    db.getReactivationProtectionStatus(admin.organization_id, 184, null, sameLegacyIdentity),
    "sent",
    "duplicata Chatwoot do mesmo celular deve herdar a proteção de reativação única"
  );

  const orgByAccount = db.getOrganizationByChatwootAccountId(4);
  assert(orgByAccount, "organização deve ser resolvida pelo account_id do webhook");
  assert.strictEqual(orgByAccount.id, admin.organization_id);

  const sentRecipient = db.listReactivationRecipients(admin.organization_id, campaign.id)
    .find((item) => item.conversationId === 501);
  const tooEarlyReply = new Date(Date.parse(sentRecipient.sentAt) - 1000).toISOString();
  assert.strictEqual(
    db.markReactivationReplyFromIncoming({
      organizationId: admin.organization_id,
      conversationId: 184,
      contactId: 114,
      canonicalPhone: reactivation.canonicalPhone("+5565999613366"),
      repliedAt: tooEarlyReply,
      replyMessageId: "old-msg",
      replyConversationId: 184,
      replyContactId: 114,
    }),
    0,
    "incoming anterior ao envio não pode contar como resposta"
  );

  const replyChanges = db.markReactivationReplyFromIncoming({
    organizationId: admin.organization_id,
    conversationId: 184,
    contactId: 114,
    canonicalPhone: reactivation.canonicalPhone("+5565999613366"),
    repliedAt: new Date(Date.now() + 1000).toISOString(),
    replyMessageId: "11801",
    replyConversationId: 184,
    replyContactId: 114,
  });
  assert.strictEqual(replyChanges, 1);
  assert.strictEqual(
    db.markReactivationReplyFromIncoming({
      organizationId: admin.organization_id,
      conversationId: 184,
      contactId: 114,
      canonicalPhone: reactivation.canonicalPhone("+5565999613366"),
      repliedAt: new Date(Date.now() + 2000).toISOString(),
      replyMessageId: "11801",
      replyConversationId: 184,
      replyContactId: 114,
    }),
    0,
    "webhook duplicado deve ser idempotente"
  );
  const repliedRecipient = db.listReactivationRecipients(admin.organization_id, campaign.id)
    .find((item) => item.conversationId === 501);
  assert.strictEqual(repliedRecipient.replyMessageId, "11801");
  assert.strictEqual(repliedRecipient.replyConversationId, 184);
  assert.strictEqual(repliedRecipient.replyContactId, 114);
  assert.strictEqual(
    repliedRecipient.canonicalPhone,
    reactivation.canonicalPhone("+5565999613366")
  );

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

console.log("CRM V1.3.6.6 canonical contact identity tests: OK");
