const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src", "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "src", "script.js"), "utf8");
const server = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");

const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const duplicateIds = htmlIds.filter((id, index) => htmlIds.indexOf(id) !== index);
assert.deepStrictEqual([...new Set(duplicateIds)], [], "HTML não pode possuir IDs duplicados");

const referencedIds = [...script.matchAll(/byId\("([^"]+)"\)/g)].map((match) => match[1]);
const missingIds = [...new Set(referencedIds.filter((id) => !htmlIds.includes(id)))];
assert.deepStrictEqual(missingIds, [], "Todo byId do JavaScript precisa existir no HTML");

for (const endpoint of [
  "/api/crm/presence/heartbeat",
  "/api/crm/presence",
  "/api/crm/handoff/targets",
  "/api/crm/opportunities/:conversationId/handoff",
  "/api/crm/transfer-requests",
  "/api/crm/transfer-requests/:id/resolve",
  "/api/crm/opportunities/:conversationId/archive",
  "/api/crm/opportunities/:conversationId/restore",
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
]) {
  assert(htmlIds.includes(id), `Elemento da V1.3.3 ausente: ${id}`);
}

assert(script.includes("const PIPELINE_COLUMN_PAGE_SIZE = 50"));
assert(script.includes("state.historyLimit += PIPELINE_COLUMN_PAGE_SIZE"));
assert(script.includes("state.archiveLimit += PIPELINE_COLUMN_PAGE_SIZE"));
assert(styles.includes("CRM V1.3.3 — controle operacional"));
assert(styles.includes("flex-direction: column"));
assert(styles.includes("border-left: 3px solid #94a3b8"));

console.log("CRM V1.3.3 static UI/API contract tests: OK");
