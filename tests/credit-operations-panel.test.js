const assert = require("assert");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-credit-panel-test-"));
const databasePath = path.join(tempDir, "crm.sqlite");

Object.assign(process.env, {
  CRM_DB_PATH: databasePath,
  CRM_ENCRYPTION_KEY: "chave-de-teste-credito-com-mais-de-24-caracteres",
  CRM_ORGANIZATION_NAME: "Loja Crédito",
  CRM_ADMIN_NAME: "Administrador",
  CRM_ADMIN_EMAIL: "admin-credit@example.com",
  CRM_ADMIN_PASSWORD: "admin-credit-123",
  CHATWOOT_ACCOUNT_ID: "51",
  CHATWOOT_API_TOKEN: "token-chatwoot-credit-test",
  REACTIVATION_SEND_ENABLED: "false",
  BASE_URL: "https://chat.example.com",
});

const expectedContract = {
  enabled: false,
  readOnly: true,
  metrics: {
    cpfCollectedToday: 0,
    processing: 0,
    waitingInput: 0,
    attentionRequired: 0,
  },
  items: [],
};

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
      // O processo ainda está inicializando.
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

async function requestCreditOperations(baseUrl, token) {
  const response = await fetch(`${baseUrl}/api/credit/operations`, {
    headers: token ? { Cookie: `crm_session=${token}` } : {},
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

(async () => {
  let child;
  try {
    const db = require("../src/db");
    const bootstrap = db.bootstrapFromEnv("https://chat.example.com");
    assert.strictEqual(bootstrap.bootstrapped, true);

    const admin = db.authenticate("admin-credit@example.com", "admin-credit-123");
    assert(admin);
    const organizationId = admin.organization_id;
    const sessions = {
      admin: db.createSession(admin, 60_000).rawToken,
    };

    const profiles = [
      { role: "manager", agentId: null, scope: "all" },
      { role: "sdr", agentId: 61, scope: "unassigned_and_mine" },
      { role: "seller", agentId: 62, scope: "mine" },
      { role: "agent", agentId: null, scope: "all" },
      { role: "viewer", agentId: null, scope: "all" },
    ];

    for (const profile of profiles) {
      const temporaryPassword = `temporaria-${profile.role}-123`;
      const permanentPassword = `permanente-${profile.role}-123`;
      const user = db.createUser({
        organizationId,
        actorUserId: admin.id,
        name: `Perfil ${profile.role}`,
        email: `${profile.role}-credit@example.com`,
        password: temporaryPassword,
        operationalRole: profile.role,
        chatwootAgentId: profile.agentId,
        visibilityScope: profile.scope,
      });
      db.changeOwnPassword({
        organizationId,
        userId: user.id,
        newPassword: permanentPassword,
        newPasswordConfirmation: permanentPassword,
      });
      const authenticated = db.authenticate(user.email, permanentPassword);
      sessions[profile.role] = db.createSession(authenticated, 60_000).rawToken;
    }

    const expectedPermissions = {
      admin: true,
      manager: true,
      sdr: true,
      seller: false,
      agent: false,
      viewer: false,
    };
    for (const [role, allowed] of Object.entries(expectedPermissions)) {
      const session = db.getSession(sessions[role]);
      assert.strictEqual(
        session.permissions.includes("credit:monitor"),
        allowed,
        `${role} credit:monitor deve ser ${allowed ? "permitido" : "negado"}`
      );
    }

    db.closeDatabase();

    const port = await availablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const output = [];
    child = spawn(process.execPath, [path.join("src", "server.js")], {
      cwd: root,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => output.push(chunk.toString()));
    child.stderr.on("data", (chunk) => output.push(chunk.toString()));
    await waitForServer(child, baseUrl, output);

    let response = await requestCreditOperations(baseUrl);
    assert.strictEqual(response.status, 401, "endpoint deve exigir sessão");

    for (const role of ["admin", "manager", "sdr"]) {
      response = await requestCreditOperations(baseUrl, sessions[role]);
      assert.strictEqual(response.status, 200, `${role} deve acessar o endpoint`);
      assert.deepStrictEqual(response.body, expectedContract, "contrato deve permanecer vazio e read-only");
    }

    for (const role of ["seller", "agent", "viewer"]) {
      response = await requestCreditOperations(baseUrl, sessions[role]);
      assert.strictEqual(response.status, 403, `${role} não deve acessar o endpoint`);
    }

    const html = fs.readFileSync(path.join(root, "src", "index.html"), "utf8");
    const script = fs.readFileSync(path.join(root, "src", "script.js"), "utf8");
    assert(html.includes('id="credit-nav-item" class="nav-item is-hidden" data-view="credit"'));
    assert(html.indexOf("credit-nav-item") > html.indexOf('data-view="tutorials"'));
    assert(html.indexOf("credit-nav-item") < html.indexOf("sidebar-spacer"));
    assert(html.includes('id="view-credit" class="view"'));
    assert(script.includes('function updateCreditNavigation()'));
    assert(script.includes('hasPermission("credit:monitor")'));
    assert(script.includes('apiRequest("/api/credit/operations")'));

    console.log("CRM credit operations panel RBAC and contract tests: OK");
  } finally {
    await stopServer(child);
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
