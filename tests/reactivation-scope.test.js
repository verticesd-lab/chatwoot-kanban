const assert = require("assert");
const access = require("../src/access-control");
const reactivation = require("../src/reactivation");
const reactivationScope = require("../src/reactivation-scope");

const eligibleLabel = "fora-de-horario";
const conversations = [
  {
    id: 1,
    labels: [eligibleLabel],
    meta: { assignee: { id: 11 } },
    custom_attributes: { crm_stage: "qualification" },
  },
  {
    id: 2,
    labels: [eligibleLabel],
    meta: { assignee: { id: 12 } },
    custom_attributes: { crm_stage: "qualification" },
  },
  {
    id: 3,
    labels: [eligibleLabel],
    meta: { assignee: null },
    custom_attributes: { crm_stage: "qualification" },
  },
  {
    id: 4,
    labels: ["etiqueta-nao-elegivel"],
    meta: { assignee: null },
    custom_attributes: { crm_stage: "qualification" },
  },
];

const sdrSession = {
  operational_role: "sdr",
  visibility_scope: "unassigned_and_mine",
  chatwoot_agent_id: 11,
};
const managerSession = {
  operational_role: "manager",
  visibility_scope: "all",
};
const adminSession = {
  operational_role: "admin",
  visibility_scope: "all",
};

const sdrReactivationConversations = reactivationScope
  .filterConversationsForReactivation(sdrSession, conversations);
assert.deepStrictEqual(
  sdrReactivationConversations.map((conversation) => conversation.id),
  [1, 2, 3, 4],
  "SDR deve receber conversas próprias, de outros agentes e sem responsável na Reativação"
);
assert(sdrReactivationConversations.some((conversation) => conversation.id === 1), "SDR deve visualizar elegível atribuído a ela");
assert(sdrReactivationConversations.some((conversation) => conversation.id === 2), "SDR deve visualizar elegível atribuído a outro agente");
assert(sdrReactivationConversations.some((conversation) => conversation.id === 3), "SDR deve visualizar elegível sem responsável");

const sdrEligible = sdrReactivationConversations.filter((conversation) =>
  reactivation.matchingEligibilityLabels(conversation, [eligibleLabel]).length > 0
);
assert.deepStrictEqual(
  sdrEligible.map((conversation) => conversation.id),
  [1, 2, 3],
  "a listagem deve excluir o lead sem etiqueta elegível"
);

const campaignConversationIndex = new Map(
  reactivationScope
    .filterConversationsForReactivation(sdrSession, conversations)
    .map((conversation) => [conversation.id, conversation])
);
assert(
  sdrEligible.every((conversation) => campaignConversationIndex.has(conversation.id)),
  "a criação da campanha deve aceitar todos os leads exibidos pela listagem"
);
assert.deepStrictEqual(
  sdrReactivationConversations.map((conversation) => conversation.id),
  [1, 2, 3, 4],
  "a busca manual deve usar o mesmo escopo amplo da Reativação"
);

assert.deepStrictEqual(
  access.filterConversationsForSession(sdrSession, conversations).map((conversation) => conversation.id),
  [1],
  "o Pipeline do SDR deve manter o escopo próprio/fila sinalizada anterior"
);

for (const session of [managerSession, adminSession]) {
  assert.deepStrictEqual(
    reactivationScope
      .filterConversationsForReactivation(session, conversations)
      .map((conversation) => conversation.id),
    [1, 2, 3, 4],
    "Gerente/Admin devem manter acesso integral"
  );
}

console.log("CRM reactivation-specific scope tests: OK");
