const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src", "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "src", "script.js"), "utf8");
const server = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
const suppression = fs.readFileSync(path.join(root, "src", "contact-suppression.js"), "utf8");
const reactivationScope = fs.readFileSync(path.join(root, "src", "reactivation-scope.js"), "utf8");

const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const duplicateIds = htmlIds.filter((id, index) => htmlIds.indexOf(id) !== index);
assert.deepStrictEqual([...new Set(duplicateIds)], [], "HTML não pode possuir IDs duplicados");

const referencedIds = [...script.matchAll(/byId\("([^"]+)"\)/g)].map((match) => match[1]);
const missingIds = [...new Set(referencedIds.filter((id) => !htmlIds.includes(id)))];
assert.deepStrictEqual(missingIds, [], "Todo byId do JavaScript precisa existir no HTML");

for (const endpoint of [
  "/api/account/password",
  "/api/crm/presence/heartbeat",
  "/api/crm/presence",
  "/api/crm/handoff/targets",
  "/api/crm/opportunities/:conversationId/handoff",
  "/api/crm/transfer-requests",
  "/api/crm/transfer-requests/:id/resolve",
  "/api/crm/opportunities/:conversationId/archive",
  "/api/crm/opportunities/:conversationId/restore",
  "/api/crm/tutorials",
  "/api/crm/tutorials/:id",
  "/api/crm/reactivations/candidates",
  "/api/crm/reactivations/campaigns",
  "/api/crm/reactivations/campaigns/:id/recipients",
  "/api/crm/reactivations/campaigns/:id/cancel",
]) {
  assert(server.includes(endpoint), `Endpoint ausente: ${endpoint}`);
}

for (const id of [
  "view-history",
  "view-archive",
  "handoff-modal",
  "archive-modal",
  "redistribution-modal",
  "sidebar-presence-list",
  "filter-period",
  "view-tutorials",
  "tutorial-video-grid",
  "tutorial-player-modal",
  "archive-scope-hint",
  "view-reactivations",
  "reactivation-nav-item",
  "reactivation-candidates-table",
  "reactivation-preview-modal",
  "reactivation-manual-modal",
  "reactivation-selected-panel",
  "reactivation-selected-list",
  "reactivation-manual-reason",
  "reactivation-manual-selected-list",
  "reactivation-preview-recipients",
]) {
  assert(htmlIds.includes(id), `Elemento da V1.3.3 ausente: ${id}`);
}

assert(script.includes("const PIPELINE_COLUMN_PAGE_SIZE = 50"));
assert(script.includes("state.historyLimit += PIPELINE_COLUMN_PAGE_SIZE"));
assert(script.includes("state.archiveLimit += PIPELINE_COLUMN_PAGE_SIZE"));
assert(styles.includes("CRM V1.3.3 — controle operacional"));
assert(styles.includes("CRM V1.3.4 — central de tutoriais"));
assert(styles.includes("CRM V1.3.6 — central de reativação manual"));
assert(script.includes("function renderReactivationCenter()"));
assert(script.includes("function reactivationDisplayCandidates()"));
assert(script.includes('sourceType: "manual"'));
assert(script.includes('"Inclusão manual"'));
assert(script.includes("sourceReason"));
assert(script.includes("function renderReactivationSelectedList()"));
assert(script.includes("function renderReactivationManualSelected()"));
assert(script.includes('"Remover"'));
assert(server.includes("validateManualSourceReason"));
assert(styles.includes("CRM V1.3.6.3 — inclusão manual auditável"));
assert(server.includes('require("./reactivation")'));
assert(server.includes('require("./reactivation-scope")'));
assert.strictEqual(
  (server.match(/const conversations = await fetchReactivationActiveConversations\(req\.crmSession\);/g) || []).length,
  2,
  "listagem e criação da campanha devem compartilhar o escopo da Reativação"
);
assert(reactivationScope.includes('operationalRole(session) === "sdr"'));
assert(script.includes("candidateResponse.manualCandidates"));
assert(script.includes("(state.reactivation.manualCandidates || [])"));
assert(server.includes("REACTIVATION_SEND_ENABLED"));
assert(server.includes("async function fetchConversationMessages"));
assert(server.includes("/conversations/${conversationId}/messages"));
assert(server.includes('action: "reactivation.reply_sync.failed"'));
assert(html.includes('value="aguardando-cpf-terceiro"'));
assert(html.includes('value="fora-de-horario"'));
assert(html.includes('value="aguardando-retorno-cliente"'));
assert(!html.includes('value="aguardando-cpf-de-terceiros"'));
assert(!html.includes('value="fora-do-horario"'));
assert(!html.includes('value="aguardando-retorno-do-cliente"'));
assert(server.includes("https://www.youtube-nocookie.com"));
assert(server.includes('Referrer-Policy", "strict-origin-when-cross-origin'));
assert(html.includes('referrerpolicy="strict-origin-when-cross-origin"'));
assert(script.includes("function renderTutorials()"));
assert(styles.includes("flex-direction: column"));
assert(styles.includes("border-left: 3px solid #94a3b8"));
assert(server.includes('require("./contact-suppression")'));
assert(server.includes("archivedContactKeys"));
assert(script.includes("function archiveScopeForReason(reason)"));
assert(script.includes('body: JSON.stringify({ reason, note, scope })'));
assert(html.includes('id="archive-scope-hint"'));
assert(suppression.includes('"lead de teste"'));
assert(suppression.includes('"sem valor operacional"'));


assert(server.includes('/api/integrations/chatwoot/reactivation-webhook'), 'webhook de reativação deve existir');
assert(server.includes('x-chatwoot-signature'), 'webhook deve validar assinatura do Chatwoot');
assert(server.includes('timingSafeEqual'), 'assinatura deve usar comparação constante');
assert(server.includes('reactivation.customer.replied.webhook'), 'resposta via webhook deve gerar auditoria');
assert(server.includes('canonicalPhone: incomingIdentity.canonicalPhone'), 'webhook deve correlacionar por telefone canônico');
assert(server.includes('recipientMatchesConversation'), 'fallback deve localizar conversas da mesma identidade');
assert(server.includes('replyConversationId'), 'auditoria deve preservar conversa de resposta');
assert(fs.existsSync(path.join(root, 'src', 'contact-identity.js')), 'módulo de identidade canônica deve existir');
assert(html.includes("Crie sua nova senha"), "tela de troca obrigatória deve existir");
assert(html.includes('id="account-password-form"'), "Minha conta deve permitir alterar senha");
assert(html.includes('data-open-password-change'), "alteração de senha deve estar sempre visível");
assert(html.includes('id="password-change-modal"'), "alteração voluntária deve abrir em modal próprio");
assert(script.includes("function showPasswordChangeRequired()"), "frontend deve isolar a troca obrigatória");
assert(script.includes("function openPasswordChangeModal()"), "frontend deve abrir a troca voluntária diretamente");
assert(script.includes('body?.code === "PASSWORD_CHANGE_REQUIRED"'), "cliente HTTP deve tratar o bloqueio central");
assert(server.includes("res.status(428)"), "backend deve bloquear APIs durante troca obrigatória");
assert(server.includes('code: "PASSWORD_CHANGE_REQUIRED"'), "bloqueio deve possuir código estável");

console.log("CRM V1.3.6.6 static UI/API contract tests: OK");
