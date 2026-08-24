const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const suppression = require("../src/contact-suppression");

const conversations = [
  {
    id: 65,
    meta: { sender: { id: 1001, phone_number: "+55 47 9755-2704", name: "Jader" } },
  },
  {
    id: 195,
    meta: { sender: { id: 1001, phone_number: "554797552704", name: "Jader | Grupo VR" } },
  },
  {
    id: 67,
    meta: { sender: { id: 1002, phone_number: "+55 48 98173-560", name: "Antonio" } },
  },
  {
    id: 194,
    meta: { sender: { id: 1002, phone_number: "+55 48 98173-560", name: "Antonio Grupo VR" } },
  },
  {
    id: 300,
    meta: { sender: { id: 1003, phone_number: "+55 48 99999-0000", name: "Cliente real" } },
  },
  {
    id: 301,
    meta: { sender: { id: 1003, phone_number: "+55 48 99999-0000", name: "Cliente real" } },
  },
];

assert.strictEqual(
  suppression.contactIdentity(conversations[0]),
  suppression.contactIdentity(conversations[1]),
  "Conversas do mesmo telefone precisam compartilhar a mesma identidade"
);

const legacyArchived = [
  { conversationId: 65, reason: "Lead de teste", archiveScope: "conversation", contactKey: "" },
  { conversationId: 194, reason: "Sem valor operacional", archiveScope: "conversation", contactKey: "" },
];

const legacyKeys = suppression.archivedContactKeys(conversations, legacyArchived);
assert(legacyKeys.has(suppression.contactIdentity(conversations[1])));
assert(legacyKeys.has(suppression.contactIdentity(conversations[2])));

const activeAfterLegacySuppression = conversations.filter(
  (conversation) => !legacyKeys.has(suppression.contactIdentity(conversation))
);
assert.deepStrictEqual(
  activeAfterLegacySuppression.map((item) => item.id),
  [300, 301],
  "Lead arquivado por motivo de descarte precisa retirar todas as conversas do mesmo contato"
);

const duplicateOnly = [
  { conversationId: 300, reason: "Duplicado", archiveScope: "conversation", contactKey: "" },
];
const duplicateKeys = suppression.archivedContactKeys(conversations, duplicateOnly);
assert.strictEqual(
  duplicateKeys.size,
  0,
  "Arquivar uma conversa duplicada não pode ocultar o contato inteiro"
);

const explicitContactArchive = [
  {
    conversationId: 300,
    reason: "Outro",
    archiveScope: "contact",
    contactKey: suppression.contactIdentity(conversations.find((item) => item.id === 300)),
  },
];
const explicitKeys = suppression.archivedContactKeys(conversations, explicitContactArchive);
assert(explicitKeys.has(suppression.contactIdentity(conversations.find((item) => item.id === 301))));

const PIPELINE_STAGES = [
  { id: "new", label: "Novo lead" },
  { id: "contacted", label: "Conversando" },
  { id: "qualification", label: "Qualificacao" },
  { id: "sem_resposta_follow_up", label: "Aguardando resposta" },
  { id: "nova_tentativa_cpf", label: "Follow-up" },
  { id: "conversas_antigas", label: "Lead frio" },
  { id: "proposal", label: "Proposta" },
  { id: "negotiation", label: "Negociacao" },
  { id: "won", label: "Ganho" },
  { id: "lost", label: "Perdido" },
  { id: "analise_manual", label: "Analise manual" },
  { id: "credito_aprovado", label: "Credito aprovado" },
];
const conversationAtStage = (status, stage, attributes = {}) => ({
  status,
  ...attributes,
  custom_attributes: {
    ...(attributes.custom_attributes || {}),
    crm_stage: stage,
  },
});

const classificationCases = [
  [conversationAtStage("open", "new"), { pipelineStages: PIPELINE_STAGES }, "active"],
  [conversationAtStage("pending", "new"), { pipelineStages: PIPELINE_STAGES }, "active"],
  [conversationAtStage("snoozed", "new"), { pipelineStages: PIPELINE_STAGES }, "active"],
  [{}, {}, "active"],
  [{ status: "unknown" }, {}, "active"],
  [{ status: "Resolved" }, {}, "active"],
  [conversationAtStage("resolved", "new"), { pipelineStages: PIPELINE_STAGES }, "chatwoot_resolved"],
  [conversationAtStage("resolved", "new"), { manuallyArchived: true }, "manual_archive"],
  [conversationAtStage("resolved", "new"), { contactSuppressed: true }, "contact_suppressed"],
  [
    { status: "resolved" },
    { manuallyArchived: true, contactSuppressed: true },
    "manual_archive",
  ],
  [{ status: "open" }, { manuallyArchived: true }, "manual_archive"],
  [{ status: "open" }, { contactSuppressed: true }, "contact_suppressed"],
];

for (const [conversation, flags, expected] of classificationCases) {
  assert.strictEqual(
    suppression.classifyWorkspaceConversation(conversation, flags),
    expected
  );
}

for (const stage of PIPELINE_STAGES.filter((item) => item.id !== "new")) {
  assert.strictEqual(
    suppression.classifyWorkspaceConversation(
      conversationAtStage("resolved", stage.id),
      { pipelineStages: PIPELINE_STAGES }
    ),
    "active",
    `resolved em ${stage.label} deve permanecer ativa`
  );
}

assert.strictEqual(
  suppression.effectiveWorkspaceStage(conversationAtStage("resolved", "contacted"), PIPELINE_STAGES),
  "contacted",
  "stage configurado deve determinar a mesma coluna efetiva do frontend"
);

assert.strictEqual(
  suppression.effectiveWorkspaceStage(
    conversationAtStage("resolved", "stage-desconhecido", { labels: ["ganho"] }),
    PIPELINE_STAGES
  ),
  "won",
  "fallback de label ganho deve coincidir com o frontend"
);
assert.strictEqual(
  suppression.effectiveWorkspaceStage(
    conversationAtStage("resolved", "stage-desconhecido", { labels: ["perdido"] }),
    PIPELINE_STAGES
  ),
  "lost",
  "fallback de label perdido deve coincidir com o frontend"
);
assert.strictEqual(
  suppression.effectiveWorkspaceStage(
    conversationAtStage("resolved", "stage-desconhecido"),
    PIPELINE_STAGES
  ),
  "new",
  "stage desconhecido sem label terminal deve cair em Novo lead como no frontend"
);

const bucketInput = [
  { id: 1, status: "open" },
  { id: 2, status: "pending" },
  { id: 3, status: "snoozed" },
  { id: 4 },
  { id: 5, status: "unknown" },
  { id: 6, ...conversationAtStage("resolved", "new") },
  { id: 7, status: "resolved" },
  { id: 8, status: "resolved" },
  { id: 9, status: "open" },
  { id: 10, status: "resolved" },
];
const bucketFlags = new Map([
  [7, { manuallyArchived: true }],
  [8, { contactSuppressed: true }],
  [9, { manuallyArchived: true }],
  [10, { manuallyArchived: true, contactSuppressed: true }],
]);
const bucketInputSnapshot = JSON.stringify(bucketInput);
const buckets = suppression.bucketWorkspaceConversations(
  bucketInput,
  (conversation) => ({
    pipelineStages: PIPELINE_STAGES,
    ...(bucketFlags.get(conversation.id) || {}),
  })
);

assert.deepStrictEqual(buckets.active.map((item) => item.id), [1, 2, 3, 4, 5]);
assert.deepStrictEqual(buckets.manualArchived.map((item) => item.id), [7, 9, 10]);
assert.deepStrictEqual(buckets.contactSuppressed.map((item) => item.id), [8]);
assert.deepStrictEqual(buckets.chatwootResolved.map((item) => item.id), [6]);
assert.strictEqual(JSON.stringify(bucketInput), bucketInputSnapshot, "bucketing nao pode alterar a entrada");

const bucketValues = Object.values(buckets);
assert.strictEqual(
  bucketValues.reduce((total, items) => total + items.length, 0),
  bucketInput.length,
  "a soma dos buckets deve ser igual ao total de entrada"
);
for (const conversation of bucketInput) {
  assert.strictEqual(
    bucketValues.reduce((total, items) => total + items.filter((item) => item === conversation).length, 0),
    1,
    `conversa ${conversation.id} deve aparecer em exatamente um bucket`
  );
}

const duplicateConversation = { id: 20, ...conversationAtStage("resolved", "new") };
const duplicateBuckets = suppression.bucketWorkspaceConversations([
  duplicateConversation,
  duplicateConversation,
], () => ({ pipelineStages: PIPELINE_STAGES }));
assert.deepStrictEqual(duplicateBuckets.chatwootResolved, [duplicateConversation, duplicateConversation]);
assert.strictEqual(
  Object.values(duplicateBuckets).reduce((total, items) => total + items.length, 0),
  2,
  "IDs duplicados devem preservar a multiplicidade da entrada"
);

const resolvedRun = suppression.bucketWorkspaceConversations(
  [{ id: 30, ...conversationAtStage("resolved", "new") }],
  () => ({ pipelineStages: PIPELINE_STAGES })
);
const reopenedRun = suppression.bucketWorkspaceConversations([{ id: 30, status: "open" }]);
const pendingRun = suppression.bucketWorkspaceConversations([{ id: 30, status: "pending" }]);
assert.deepStrictEqual(resolvedRun.chatwootResolved.map((item) => item.id), [30]);
assert.deepStrictEqual(reopenedRun.active.map((item) => item.id), [30]);
assert.deepStrictEqual(pendingRun.active.map((item) => item.id), [30]);

// Persiste o novo escopo no banco e garante que a migração V1.3.5 funciona.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-suppression-test-"));
process.env.CRM_DB_PATH = path.join(tempDir, "crm.sqlite");
process.env.CRM_ENCRYPTION_KEY = "chave-de-teste-com-mais-de-24-caracteres";
process.env.CRM_ORGANIZATION_NAME = "Loja Supressao";
process.env.CRM_ADMIN_NAME = "Administrador";
process.env.CRM_ADMIN_EMAIL = "admin-suppression@example.com";
process.env.CRM_ADMIN_PASSWORD = "senha-segura-123";
process.env.CHATWOOT_ACCOUNT_ID = "4";
process.env.CHATWOOT_API_TOKEN = "token-chatwoot-teste";

const db = require("../src/db");
try {
  db.bootstrapFromEnv("https://chat.example.com");
  const admin = db.authenticate("admin-suppression@example.com", "senha-segura-123");
  const archived = db.archiveOpportunity({
    organizationId: admin.organization_id,
    conversationId: 900,
    actorUserId: admin.id,
    reason: "Lead de teste",
    archiveScope: "contact",
    contactKey: "phone:5547999990000",
  });
  assert.strictEqual(archived.archiveScope, "contact");
  assert.strictEqual(archived.contactKey, "phone:5547999990000");
  assert.strictEqual(db.listArchivedOpportunities(admin.organization_id).length, 1);
} finally {
  db.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

console.log("CRM V1.3.5 contact suppression tests: OK");
