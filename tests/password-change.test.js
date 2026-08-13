const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-password-test-"));
const databasePath = path.join(tempDir, "crm.sqlite");
const port = 32000 + (process.pid % 1000);
const baseUrl = `http://127.0.0.1:${port}`;

Object.assign(process.env, {
  CRM_DB_PATH: databasePath,
  CRM_ENCRYPTION_KEY: "chave-de-teste-com-mais-de-24-caracteres",
  CRM_ORGANIZATION_NAME: "Loja Senhas",
  CRM_ADMIN_NAME: "Administrador",
  CRM_ADMIN_EMAIL: "admin-password@example.com",
  CRM_ADMIN_PASSWORD: "admin-segura-123",
  CHATWOOT_ACCOUNT_ID: "41",
  CHATWOOT_API_TOKEN: "token-chatwoot-password-test",
  REACTIVATION_SEND_ENABLED: "false",
  PORT: String(port),
  BASE_URL: "https://chat.example.com",
});

function cookie(token) {
  return `crm_session=${token}`;
}

async function api(pathname, { token, method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(token ? { Cookie: cookie(token) } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = response.status === 204
    ? null
    : contentType.includes("application/json") ? await response.json() : await response.text();
  return { status: response.status, body: payload, headers: response.headers };
}

async function waitForServer(child, output) {
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
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

(async () => {
  let child;
  try {
    const db = require("../src/db");
    const bootstrap = db.bootstrapFromEnv("https://chat.example.com");
    assert.strictEqual(bootstrap.bootstrapped, true);

    const admin = db.authenticate("admin-password@example.com", "admin-segura-123");
    assert(admin);
    const adminToken = db.createSession(admin, 60_000).rawToken;
    assert.strictEqual(db.getSession(adminToken).must_change_password, 0);
    assert.strictEqual(db.sessionPayload(db.getSession(adminToken)).user.mustChangePassword, false);

    const legacy = db.createUser({
      organizationId: admin.organization_id,
      actorUserId: admin.id,
      name: "Usuário legado",
      email: "legacy-password@example.com",
      password: "temporaria-123",
      operationalRole: "manager",
      visibilityScope: "all",
    });
    assert.strictEqual(legacy.mustChangePassword, true, "usuário novo deve receber senha temporária");

    db.changeOwnPassword({
      organizationId: admin.organization_id,
      userId: legacy.id,
      newPassword: "legado-seguro-123",
      newPasswordConfirmation: "legado-seguro-123",
    });
    const legacyAuth = db.authenticate(legacy.email, "legado-seguro-123");
    const legacyToken = db.createSession(legacyAuth, 60_000).rawToken;
    assert.strictEqual(db.getSession(legacyToken).must_change_password, 0);

    const dryRun = db.markUsersMustChangePassword({
      userIds: [legacy.id],
      excludeUserIds: [admin.id],
    });
    assert.strictEqual(dryRun[0].status, "would_mark");
    assert.strictEqual(db.getSession(legacyToken).must_change_password, 0, "dry-run não altera usuário");

    const excluded = db.markUsersMustChangePassword({
      userIds: [admin.id],
      excludeUserIds: [admin.id],
      apply: true,
    });
    assert.strictEqual(excluded[0].status, "excluded");
    assert.strictEqual(db.getSession(adminToken).must_change_password, 0);

    const applied = db.markUsersMustChangePassword({ userIds: [legacy.id], apply: true });
    assert.strictEqual(applied[0].status, "marked");
    assert.strictEqual(
      db.getSession(legacyToken).must_change_password,
      1,
      "sessão criada antes da marcação deve reler a obrigação"
    );
    const repeated = db.markUsersMustChangePassword({ userIds: [legacy.id], apply: true });
    assert.strictEqual(repeated[0].status, "already_marked", "marcação deve ser idempotente");
    assert(db.listAudit(admin.organization_id, 100).some(
      (entry) => entry.action === "user.password_change_required.marked"
    ));
    db.closeDatabase();

    const output = [];
    child = spawn(process.execPath, [path.join("src", "server.js")], {
      cwd: path.resolve(__dirname, ".."),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => output.push(chunk.toString()));
    child.stderr.on("data", (chunk) => output.push(chunk.toString()));
    await waitForServer(child, output);

    let response = await api("/api/session", { token: legacyToken });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.user.mustChangePassword, true);

    response = await api("/api/crm/config", { token: legacyToken });
    assert.strictEqual(response.status, 428, "APIs do CRM devem ficar bloqueadas");
    assert.strictEqual(response.body.code, "PASSWORD_CHANGE_REQUIRED");

    response = await api("/api/account/password", {
      token: legacyToken,
      method: "PUT",
      body: {
        userId: admin.id,
        newPassword: "tentativa-terceiro-123",
        newPasswordConfirmation: "tentativa-terceiro-123",
      },
    });
    assert.strictEqual(response.status, 400);
    assert.strictEqual(response.body.code, "ARBITRARY_USER_ID_NOT_ALLOWED");

    response = await api("/api/account/password", {
      token: legacyToken,
      method: "PUT",
      body: { newPassword: "nova-segura-123", newPasswordConfirmation: "divergente-123" },
    });
    assert.strictEqual(response.status, 400);
    assert.strictEqual(response.body.code, "PASSWORD_CONFIRMATION_MISMATCH");

    response = await api("/api/account/password", {
      token: legacyToken,
      method: "PUT",
      body: { newPassword: "curta", newPasswordConfirmation: "curta" },
    });
    assert.strictEqual(response.status, 400);
    assert.strictEqual(response.body.code, "PASSWORD_TOO_SHORT");

    response = await api("/api/account/password", {
      token: legacyToken,
      method: "PUT",
      body: { newPassword: "nova-segura-123", newPasswordConfirmation: "nova-segura-123" },
    });
    assert.strictEqual(response.status, 200, "troca obrigatória não exige senha temporária novamente");
    assert.strictEqual(response.body.user.mustChangePassword, false);

    response = await api("/api/crm/config", { token: legacyToken });
    assert.strictEqual(response.status, 200, "CRM deve ser liberado após a troca");

    response = await api("/api/account/password", {
      token: legacyToken,
      method: "PUT",
      body: {
        currentPassword: "senha-incorreta-123",
        newPassword: "voluntaria-123",
        newPasswordConfirmation: "voluntaria-123",
      },
    });
    assert.strictEqual(response.status, 400);
    assert.strictEqual(response.body.code, "CURRENT_PASSWORD_INCORRECT");

    response = await api("/api/account/password", {
      token: legacyToken,
      method: "PUT",
      body: {
        currentPassword: "nova-segura-123",
        newPassword: "voluntaria-123",
        newPasswordConfirmation: "voluntaria-123",
      },
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.user.mustChangePassword, false);

    response = await api("/api/session", {
      method: "POST",
      body: { email: legacy.email, password: "nova-segura-123" },
    });
    assert.strictEqual(response.status, 401, "senha anterior não deve continuar válida");
    response = await api("/api/session", {
      method: "POST",
      body: { email: legacy.email, password: "voluntaria-123" },
    });
    assert.strictEqual(response.status, 200, "hash novo deve autenticar pelo mecanismo existente");
    assert.strictEqual(response.body.user.mustChangePassword, false);

    response = await api("/api/session", { token: adminToken });
    assert.strictEqual(response.body.user.mustChangePassword, false, "Admin bootstrap não deve ser bloqueado");

    response = await api("/api/crm/users", {
      token: adminToken,
      method: "POST",
      body: {
        name: "Gerente novo",
        email: "new-manager@example.com",
        password: "temporaria-nova-123",
        operationalRole: "manager",
        visibilityScope: "all",
      },
    });
    assert.strictEqual(response.status, 201);
    assert.strictEqual(response.body.user.mustChangePassword, true);

    response = await api(`/api/crm/users/${legacy.id}`, {
      token: adminToken,
      method: "PATCH",
      body: { password: "reset-temporario-123" },
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.user.mustChangePassword, true);

    response = await api("/api/crm/config", { token: legacyToken });
    assert.strictEqual(response.status, 428, "reset deve bloquear uma sessão que já estava ativa");
    assert.strictEqual(response.body.code, "PASSWORD_CHANGE_REQUIRED");

    response = await api("/api/session", {
      method: "POST",
      body: { email: legacy.email, password: "reset-temporario-123" },
    });
    assert.strictEqual(response.status, 200, "login com senha temporária continua permitido");
    assert.strictEqual(response.body.user.mustChangePassword, true);

    response = await api("/api/session", { token: legacyToken, method: "DELETE" });
    assert.strictEqual(response.status, 204, "logout deve continuar permitido durante bloqueio");

    await stopServer(child);
    child = null;

    const verificationDb = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert(verificationDb.prepare(
        "SELECT 1 FROM schema_migrations WHERE version = 6"
      ).get(), "migration de senha deve estar registrada");
      const serializedAudit = verificationDb.prepare(`
        SELECT COALESCE(GROUP_CONCAT(COALESCE(before_json, '') || COALESCE(after_json, '') || COALESCE(metadata_json, '')), '') AS content
        FROM audit_logs
      `).get().content;
      for (const secret of [
        "temporaria-123",
        "legado-seguro-123",
        "nova-segura-123",
        "voluntaria-123",
        "reset-temporario-123",
      ]) {
        assert(!serializedAudit.includes(secret), "auditoria não pode registrar senhas");
      }
    } finally {
      verificationDb.close();
    }

    console.log("CRM password change and enforcement tests: OK");
  } finally {
    if (child) await stopServer(child);
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
