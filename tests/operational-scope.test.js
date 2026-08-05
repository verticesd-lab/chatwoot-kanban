const assert = require("assert");
const access = require("../src/access-control");

const conversations = [
  { id: 1, labels: [], meta: { assignee: null }, last_activity_at: 100 },
  { id: 2, labels: ["precisa-humano"], meta: { assignee: { id: 11 } }, last_activity_at: 90 },
  { id: 3, labels: [], meta: { assignee: { id: 12 } }, last_activity_at: 80 },
  { id: 4, labels: ["atendimento-manual"], meta: { assignee: null }, last_activity_at: 70 },
  { id: 5, labels: ["aguardando-analise-manual"], meta: { assignee: null }, last_activity_at: 60 },
  { id: 6, labels: [], meta: { assignee: { id: 11 } }, last_activity_at: 50 },
];

assert.deepStrictEqual(
  access.filterConversationsForSession(
    { visibility_scope: "all" },
    conversations
  ).map((item) => item.id),
  [1, 2, 3, 4, 5, 6]
);

// SDR: não recebe todo o histórico sem responsável. Recebe somente
// a fila sinalizada e os leads já atribuídos ao próprio agente.
assert.deepStrictEqual(
  access.filterConversationsForSession(
    {
      operational_role: "sdr",
      visibility_scope: "unassigned_and_mine",
      chatwoot_agent_id: 11,
    },
    conversations
  ).map((item) => item.id),
  [2, 4, 5, 6]
);

assert.deepStrictEqual(
  access.filterConversationsForSession(
    {
      operational_role: "sdr",
      visibility_scope: "unassigned",
      chatwoot_agent_id: 11,
    },
    conversations
  ).map((item) => item.id),
  [4, 5]
);

assert.deepStrictEqual(
  access.filterConversationsForSession(
    { operational_role: "seller", visibility_scope: "mine", chatwoot_agent_id: 12 },
    conversations
  ).map((item) => item.id),
  [3]
);

assert.strictEqual(access.isSdrQueueConversation(conversations[0]), false);
assert.strictEqual(access.isSdrQueueConversation(conversations[4]), true);
assert.strictEqual(access.isInterventionConversation(conversations[1]), true);
assert.strictEqual(access.isInterventionConversation(conversations[2]), false);
assert.strictEqual(access.sortOperationalQueue(conversations)[0].id, 2);

console.log("CRM V1.3.2 operational scope tests: OK");
