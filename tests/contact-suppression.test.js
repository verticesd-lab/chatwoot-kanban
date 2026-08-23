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

const CLASSIFICATION_NOW = Date.parse("2026-08-23T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORICAL_CUTOFF = "2026-08-07T00:00:00-04:00";
const HISTORICAL_CUTOFF_MS = Date.parse(HISTORICAL_CUTOFF);
const oldResolvedConversation = (attributes = {}) => ({
  status: "resolved",
  last_activity_at: new Date(CLASSIFICATION_NOW - 8 * DAY_MS).toISOString(),
  ...attributes,
});

const classificationCases = [
  [{ status: "open" }, {}, "active"],
  [{ status: "pending" }, {}, "active"],
  [{ status: "snoozed" }, {}, "active"],
  [{}, {}, "active"],
  [{ status: "unknown" }, {}, "active"],
  [{ status: "Resolved" }, {}, "active"],
  [oldResolvedConversation(), { now: CLASSIFICATION_NOW }, "chatwoot_resolved"],
  [{ status: "resolved" }, { manuallyArchived: true }, "manual_archive"],
  [{ status: "resolved" }, { contactSuppressed: true }, "contact_suppressed"],
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

assert.strictEqual(
  suppression.classifyWorkspaceConversation(
    {
      status: "resolved",
      last_activity_at: new Date(CLASSIFICATION_NOW - DAY_MS).toISOString(),
    },
    { now: CLASSIFICATION_NOW }
  ),
  "active",
  "resolved com um dia deve permanecer ativa"
);
assert.strictEqual(
  suppression.classifyWorkspaceConversation(
    {
      status: "resolved",
      last_activity_at: new Date(CLASSIFICATION_NOW - 7 * DAY_MS).toISOString(),
    },
    { now: CLASSIFICATION_NOW }
  ),
  "active",
  "resolved exatamente no limite de sete dias deve permanecer ativa"
);
assert.strictEqual(
  suppression.classifyWorkspaceConversation(
    {
      status: "resolved",
      last_activity_at: new Date(CLASSIFICATION_NOW - 7 * DAY_MS - 1).toISOString(),
    },
    { now: CLASSIFICATION_NOW }
  ),
  "chatwoot_resolved",
  "resolved com mais de sete dias e sem protecao deve ir ao arquivo derivado"
);

for (const stage of [
  "contacted",
  "qualification",
  "proposal",
  "negotiation",
  "nova_tentativa_cpf",
  "analise_manual",
  "credito_aprovado",
  "sem_resposta_follow_up",
  "sem_resposta_followup",
]) {
  assert.strictEqual(
    suppression.classifyWorkspaceConversation(
      oldResolvedConversation({ custom_attributes: { crm_stage: stage } }),
      { now: CLASSIFICATION_NOW }
    ),
    "active",
    `stage operacional ${stage} deve proteger a oportunidade`
  );
}

for (const stage of [undefined, "new"]) {
  assert.strictEqual(
    suppression.classifyWorkspaceConversation(
      oldResolvedConversation({ custom_attributes: { crm_stage: stage } }),
      { now: CLASSIFICATION_NOW }
    ),
    "chatwoot_resolved",
    `${stage || "stage ausente"} sozinho nao deve proteger oportunidade antiga`
  );
}

assert.strictEqual(
  suppression.classifyWorkspaceConversation(
    oldResolvedConversation({
      custom_attributes: { fase_qualificacao: "aguardando_cpf_terceiro" },
    }),
    { now: CLASSIFICATION_NOW }
  ),
  "active",
  "fase de qualificacao aguardando deve proteger a oportunidade"
);

for (const crmTaskDueAt of ["2026-08-01", "2026-09-01"]) {
  assert.strictEqual(
    suppression.classifyWorkspaceConversation(
      oldResolvedConversation({
        custom_attributes: {
          crm_next_task: "Retornar cliente",
          crm_task_due_at: crmTaskDueAt,
          crm_task_done: false,
        },
      }),
      { now: CLASSIFICATION_NOW }
    ),
    "active",
    "tarefa comercial vencida ou pendente deve proteger a oportunidade"
  );
}
assert.strictEqual(
  suppression.classifyWorkspaceConversation(
    oldResolvedConversation({
      custom_attributes: {
        crm_next_task: "Retornar cliente",
        crm_task_due_at: "2026-08-01",
        crm_task_done: true,
      },
    }),
    { now: CLASSIFICATION_NOW }
  ),
  "chatwoot_resolved",
  "tarefa concluida nao deve proteger oportunidade antiga sozinha"
);

for (const label of [
  "precisa-humano",
  "atendimento-manual",
  "aguardando-analise-manual",
  "aguardando-cpf-terceiro",
  "aguardando-retorno-cliente",
  "lead-com-sdr",
]) {
  assert.strictEqual(
    suppression.classifyWorkspaceConversation(
      oldResolvedConversation({ labels: [label] }),
      { now: CLASSIFICATION_NOW }
    ),
    "active",
    `label operacional ${label} deve proteger a oportunidade`
  );
}

for (const label of [
  "fora-de-horario",
  "lead-frio-sem-resposta",
  "reativacao-unica-enviada",
  "followup-bloqueado",
]) {
  assert.strictEqual(
    suppression.classifyWorkspaceConversation(
      oldResolvedConversation({ labels: [label] }),
      { now: CLASSIFICATION_NOW }
    ),
    "chatwoot_resolved",
    `label ${label} isolada nao deve proteger oportunidade antiga`
  );
}

assert.strictEqual(
  suppression.classifyWorkspaceConversation(
    {
      status: "resolved",
      updated_at: new Date(CLASSIFICATION_NOW - 8 * DAY_MS).toISOString(),
    },
    { now: CLASSIFICATION_NOW }
  ),
  "chatwoot_resolved",
  "updated_at deve ser o fallback quando last_activity_at estiver ausente"
);
assert.strictEqual(
  suppression.classifyWorkspaceConversation(
    {
      status: "resolved",
      created_at: new Date(CLASSIFICATION_NOW - 8 * DAY_MS).toISOString(),
    },
    { now: CLASSIFICATION_NOW }
  ),
  "chatwoot_resolved",
  "created_at deve ser o fallback quando os demais timestamps estiverem ausentes"
);
assert.strictEqual(
  suppression.classifyWorkspaceConversation({ status: "resolved" }, { now: CLASSIFICATION_NOW }),
  "active",
  "sem timestamp nao e seguro afirmar que a atividade passou de sete dias"
);

assert.strictEqual(suppression.parseHistoricalCutoff(""), null);
assert.strictEqual(suppression.parseHistoricalCutoff(HISTORICAL_CUTOFF), HISTORICAL_CUTOFF_MS);
assert.throws(
  () => suppression.parseHistoricalCutoff("2026-08-07"),
  /timezone explicito/,
  "cutoff date-only nao pode depender do timezone do processo"
);

assert.strictEqual(
  suppression.classifyWorkspaceConversation(
    {
      status: "resolved",
      last_activity_at: new Date(HISTORICAL_CUTOFF_MS - 1).toISOString(),
      custom_attributes: { crm_stage: "contacted" },
    },
    { now: CLASSIFICATION_NOW, historicalCutoff: HISTORICAL_CUTOFF }
  ),
  "chatwoot_resolved",
  "resolved anterior ao cutoff deve usar a regra historica"
);
assert.strictEqual(
  suppression.classifyWorkspaceConversation(
    {
      status: "resolved",
      created_at: "2026-08-01T12:00:00.000Z",
      last_activity_at: "2026-08-20T12:00:00.000Z",
    },
    { now: CLASSIFICATION_NOW, historicalCutoff: HISTORICAL_CUTOFF }
  ),
  "active",
  "criacao anterior nao prevalece sobre atividade posterior ao cutoff"
);
for (const status of ["open", "pending", "snoozed"]) {
  assert.strictEqual(
    suppression.classifyWorkspaceConversation(
      {
        status,
        last_activity_at: new Date(HISTORICAL_CUTOFF_MS - DAY_MS).toISOString(),
      },
      { now: CLASSIFICATION_NOW, historicalCutoff: HISTORICAL_CUTOFF }
    ),
    "active",
    `${status} antiga nunca deve entrar no arquivo historico`
  );
}
assert.strictEqual(
  suppression.classifyWorkspaceConversation(
    {
      status: "resolved",
      last_activity_at: new Date(HISTORICAL_CUTOFF_MS).toISOString(),
      custom_attributes: { crm_stage: "contacted" },
    },
    { now: CLASSIFICATION_NOW, historicalCutoff: HISTORICAL_CUTOFF }
  ),
  "active",
  "atividade exatamente no cutoff nao pertence ao historico"
);
assert.strictEqual(
  suppression.classifyWorkspaceConversation(
    {
      status: "resolved",
      last_activity_at: new Date(HISTORICAL_CUTOFF_MS - DAY_MS).toISOString(),
    },
    {
      now: CLASSIFICATION_NOW,
      historicalCutoff: HISTORICAL_CUTOFF,
      manuallyArchived: true,
    }
  ),
  "manual_archive"
);
assert.strictEqual(
  suppression.classifyWorkspaceConversation(
    {
      status: "resolved",
      last_activity_at: new Date(HISTORICAL_CUTOFF_MS - DAY_MS).toISOString(),
    },
    {
      now: CLASSIFICATION_NOW,
      historicalCutoff: HISTORICAL_CUTOFF,
      contactSuppressed: true,
    }
  ),
  "contact_suppressed"
);
assert.strictEqual(
  suppression.classifyWorkspaceConversation(
    oldResolvedConversation(),
    { now: CLASSIFICATION_NOW, historicalCutoff: HISTORICAL_CUTOFF }
  ),
  "chatwoot_resolved",
  "atividade apos o cutoff deve continuar usando o safe predicate"
);

const bucketInput = [
  { id: 1, status: "open" },
  { id: 2, status: "pending" },
  { id: 3, status: "snoozed" },
  { id: 4 },
  { id: 5, status: "unknown" },
  { id: 6, ...oldResolvedConversation() },
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
  (conversation) => ({ now: CLASSIFICATION_NOW, ...(bucketFlags.get(conversation.id) || {}) })
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

const duplicateConversation = { id: 20, ...oldResolvedConversation() };
const duplicateBuckets = suppression.bucketWorkspaceConversations([
  duplicateConversation,
  duplicateConversation,
], () => ({ now: CLASSIFICATION_NOW }));
assert.deepStrictEqual(duplicateBuckets.chatwootResolved, [duplicateConversation, duplicateConversation]);
assert.strictEqual(
  Object.values(duplicateBuckets).reduce((total, items) => total + items.length, 0),
  2,
  "IDs duplicados devem preservar a multiplicidade da entrada"
);

const resolvedRun = suppression.bucketWorkspaceConversations(
  [{ id: 30, ...oldResolvedConversation() }],
  () => ({ now: CLASSIFICATION_NOW })
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
