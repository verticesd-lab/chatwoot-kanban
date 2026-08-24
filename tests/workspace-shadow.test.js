const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const root = path.resolve(__dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-workspace-shadow-test-"));
const databasePath = path.join(tempDir, "crm.sqlite");
const conversations = [
  { id: 101, status: "resolved", labels: [], meta: { sender: { phone_number: "+55 65 90000-0101" } } },
  { id: 102, status: "resolved", labels: [], meta: { sender: { phone_number: "+55 65 90000-0102" } } },
  { id: 103, status: "resolved", labels: [], meta: { sender: { phone_number: "+55 65 90000-0103" } } },
  { id: 104, status: "open", labels: [], meta: { sender: { phone_number: "5565900000103" } } },
  { id: 105, status: "open", labels: [], meta: { sender: { phone_number: "+55 65 90000-0105" } } },
  { id: 106, status: "pending", labels: [], meta: { sender: { phone_number: "+55 65 90000-0106" } } },
  { id: 107, status: "snoozed", labels: [], meta: { sender: { phone_number: "+55 65 90000-0107" } } },
  { id: 109, status: "resolved", labels: [], custom_attributes: { crm_stage: "contacted" }, meta: { sender: { phone_number: "+55 65 90000-0109" } } },
];

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function startChatwootMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/api/v1/accounts/71/conversations") {
        assert.strictEqual(url.searchParams.get("status"), "all");
        assert.strictEqual(url.searchParams.get("assignee_type"), "all");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: { payload: conversations } }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function waitForServer(child, baseUrl, output) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Servidor encerrou antes de iniciar:\n${output.join("")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch (_error) {
      // O processo ainda estÃ¡ inicializando.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timeout ao iniciar servidor:\n${output.join("")}`);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

async function startCrm(extraEnv = {}) {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, [path.join("src", "server.js")], {
    cwd: root,
    env: { ...process.env, PORT: String(port), ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  await waitForServer(child, baseUrl, output);
  return { child, baseUrl };
}

async function requestWorkspace(baseUrl, token) {
  const response = await fetch(`${baseUrl}/api/crm/workspace/conversations`, {
    headers: { Cookie: `crm_session=${token}` },
  });
  assert.strictEqual(response.status, 200);
  return response.json();
}

function ids(items) {
  return items.map((item) => Number(item.id)).sort((a, b) => a - b);
}

(async () => {
  let child;
  let chatwoot;
  try {
    chatwoot = await startChatwootMock();
    Object.assign(process.env, {
      CRM_DB_PATH: databasePath,
      CRM_ENCRYPTION_KEY: "chave-shadow-com-mais-de-24-caracteres",
      CRM_ORGANIZATION_NAME: "Loja Shadow",
      CRM_ADMIN_NAME: "Administrador",
      CRM_ADMIN_EMAIL: "admin-shadow@example.com",
      CRM_ADMIN_PASSWORD: "admin-shadow-123",
      CHATWOOT_ACCOUNT_ID: "71",
      CHATWOOT_API_TOKEN: "token-chatwoot-shadow-test",
      REACTIVATION_SEND_ENABLED: "false",
      BASE_URL: chatwoot.baseUrl,
    });

    const db = require("../src/db");
    db.bootstrapFromEnv(chatwoot.baseUrl);
    const admin = db.authenticate("admin-shadow@example.com", "admin-shadow-123");
    const token = db.createSession(admin, 60_000).rawToken;
    db.archiveOpportunity({
      organizationId: admin.organization_id,
      conversationId: 102,
      actorUserId: admin.id,
      reason: "Duplicado",
      archiveScope: "conversation",
    });
    db.archiveOpportunity({
      organizationId: admin.organization_id,
      conversationId: 104,
      actorUserId: admin.id,
      reason: "Outro",
      archiveScope: "contact",
      contactKey: "phone:5565900000103",
    });
    db.closeDatabase();

    let crm = await startCrm({ CHATWOOT_RESOLVED_ARCHIVE_ENABLED: "false" });
    child = crm.child;
    const body = await requestWorkspace(crm.baseUrl, token);

    assert.deepStrictEqual(ids(body.chatwootResolvedConversations), [101]);
    assert.deepStrictEqual(
      ids(body.conversations),
      [101, 105, 106, 107, 109],
      "array ativo deve preservar a selecao legada, inclusive conversa resolved"
    );
    assert.deepStrictEqual(
      ids(body.archivedConversations),
      [102, 104],
      "array arquivado deve continuar contendo somente arquivos manuais"
    );
    assert(body.archivedConversations.every((item) => item.archiveSource === undefined));
    assert.strictEqual(
      body.archivedConversations.find((item) => Number(item.id) === 102).crm_archive.reason,
      "Duplicado"
    );
    assert(!ids(body.archivedConversations).includes(101));
    assert(!ids(body.conversations).includes(103));
    assert(!ids(body.archivedConversations).includes(103));

    await stopServer(child);
    child = null;
    crm = await startCrm({ CHATWOOT_RESOLVED_ARCHIVE_ENABLED: "true" });
    child = crm.child;
    const enabledBody = await requestWorkspace(crm.baseUrl, token);
    assert.deepStrictEqual(ids(enabledBody.conversations), [105, 106, 107, 109]);
    assert.deepStrictEqual(ids(enabledBody.archivedConversations), [101, 102, 104]);

    const resolvedArchive = enabledBody.archivedConversations.find((item) => Number(item.id) === 101);
    assert.strictEqual(resolvedArchive.archiveSource, "chatwoot_resolved");
    assert.strictEqual(resolvedArchive.crm_archive, undefined);
    assert(
      ids(enabledBody.conversations).includes(109),
      "resolved fora de Novo lead deve permanecer ativo"
    );
    const manualArchive = enabledBody.archivedConversations.find((item) => Number(item.id) === 102);
    assert.strictEqual(manualArchive.archiveSource, "manual");
    assert.strictEqual(manualArchive.crm_archive.reason, "Duplicado");
    assert.strictEqual(
      enabledBody.archivedConversations.filter((item) => Number(item.id) === 102).length,
      1
    );
    assert(!ids(enabledBody.conversations).includes(103));
    assert(!ids(enabledBody.archivedConversations).includes(103));

    conversations.find((item) => item.id === 101).status = "open";
    const reopenedBody = await requestWorkspace(crm.baseUrl, token);
    assert(ids(reopenedBody.conversations).includes(101));
    assert(!ids(reopenedBody.archivedConversations).includes(101));
    assert(!ids(reopenedBody.chatwootResolvedConversations).includes(101));

    await stopServer(child);
    child = null;
    const archiveDb = new DatabaseSync(databasePath, { readOnly: true });
    const archiveRows = archiveDb.prepare(`
      SELECT conversation_id FROM archived_opportunities WHERE active = 1 ORDER BY conversation_id
    `).all();
    archiveDb.close();
    assert.deepStrictEqual(archiveRows.map((item) => Number(item.conversation_id)), [102, 104]);

    console.log("CRM workspace resolved shadow and flagged archive tests: OK");
  } finally {
    await stopServer(child);
    if (chatwoot) await new Promise((resolve) => chatwoot.server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
