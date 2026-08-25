const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-credit-panel-test-"));
const databasePath = path.join(tempDir, "crm.sqlite");
const upstreamToken = "token-autocore-teste-credito-1234567890-seguro";

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
  CREDIT_PANEL_ENABLED: "false",
  CREDIT_PANEL_WRITE_ENABLED: "false",
});

const expectedDisabledContract = {
  enabled: false,
  readOnly: true,
  metrics: { cpfCollectedToday: 0, processing: 0, waitingInput: 0, attentionRequired: 0 },
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
    if (child.exitCode !== null) throw new Error(`Servidor encerrou antes de iniciar:\n${output.join("")}`);
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

async function requestCreditOperations(baseUrl, token, query = "") {
  const response = await fetch(`${baseUrl}/api/credit/operations${query}`, {
    headers: token ? { Cookie: `crm_session=${token}` } : {},
  });
  return { status: response.status, body: await response.json() };
}

function validUpstreamContract(readOnly = true) {
  const unexpected = {
    cpf: "12345678901",
    phone: "+5565999999999",
    email: "pessoa@example.com",
    birthdate: "1990-01-01",
    cnh: "12345678900",
    payload_json: { secret: "raw-job-payload" },
    pre_approval_status: "approved-secret",
    tokens: [upstreamToken],
    secrets: "internal-secret",
  };
  return {
    enabled: true,
    readOnly,
    generatedAt: "2026-08-14T12:00:00.000Z",
    storeId: 999,
    metrics: { cpfCollectedToday: 2, processing: 1, waitingInput: 0, attentionRequired: 1, secretMetric: 9 },
    ...unexpected,
    items: [
      {
        conversationId: "123",
        stateUuid: "7b342f91-00c1-4bed-a345-55e7aa8fbfff",
        revision: 1,
        applicantAttempt: 1,
        status: "processing",
        cpfLast4: "4725",
        ...unexpected,
        facts: {
          cpfPresent: true,
          birthDatePresent: false,
          phonePresent: true,
          emailPresent: false,
          cnhPresent: false,
          downPayment: { known: false, cents: null, raw: "não vazar" },
          cpf: "12345678901",
        },
        banks: [{
          code: "623", name: null, status: "processing", available: null,
          missingFields: ["birth_date"], token: upstreamToken,
        }],
        job: {
          type: "credit.credere.portfolio.execute", status: "processing", attempts: 1, maxAttempts: 2,
          createdAt: "2026-08-14T11:00:00.000Z", updatedAt: "2026-08-14T12:00:00.000Z",
          payload_json: { cpf: "12345678901" },
        },
        nextAction: null,
        createdAt: "2026-08-14T11:00:00.000Z",
        updatedAt: "2026-08-14T12:00:00.000Z",
      },
      {
        conversationId: "124",
        stateUuid: "e2cc31f7-1cd2-4c08-9d82-f6dbd9028d54",
        revision: 2,
        applicantAttempt: 2,
        status: "ready",
        cpfLast4: "47x5",
        facts: {
          cpfPresent: true, birthDatePresent: true, phonePresent: true, emailPresent: true, cnhPresent: true,
          downPayment: { known: true, cents: 0 },
        },
        banks: [{ code: "001", name: "Banco Teste", status: "ready", available: false, missingFields: [] }],
        job: null,
        nextAction: "review",
        createdAt: "2026-08-14T10:00:00.000Z",
        updatedAt: "2026-08-14T12:05:00.000Z",
      },
    ],
  };
}

function findForbiddenKey(value, forbiddenKeys) {
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) return key;
    const nested = findForbiddenKey(child, forbiddenKeys);
    if (nested) return nested;
  }
  return null;
}

function loadCreditPeriodFrontendHarness() {
  const source = fs.readFileSync(path.join(root, "src", "script.js"), "utf8");
  const context = {
    document: { addEventListener() {} },
    URLSearchParams,
  };
  vm.runInNewContext(`${source}\n;globalThis.__creditPeriodHarness = {
    getWindow: getCreditPeriodWindow,
    buildUrl: buildCreditOperationsUrl,
    bankOptions: (items) => JSON.stringify(getCreditOpportunityBankOptions(items)),
    filterOperations: (items, opportunityFilter, bankFilter) => JSON.stringify(
      filterCreditOperations(items, opportunityFilter, bankFilter).map((item) => item.conversationId)
    ),
    getState: () => JSON.stringify({
      preset: state.credit.periodPreset,
      start: state.credit.periodStart,
      end: state.credit.periodEnd,
    }),
    renderLabels(preset, start = "", end = "") {
      const active = { textContent: "" };
      const metric = { textContent: "" };
      state.credit.periodPreset = preset;
      state.credit.periodStart = start;
      state.credit.periodEnd = end;
      Object.assign(elements, {
        creditPeriodActive: active,
        creditMetricCpfLabel: metric,
      });
      renderCreditPeriodState();
      return JSON.stringify({ active: active.textContent, metric: metric.textContent });
    },
    async changePreset(preset) {
      const calls = [];
      const originalLoad = loadCreditOperations;
      loadCreditOperations = async (options) => calls.push(options.periodSelection);
      Object.assign(elements, {
        creditPeriodPreset: { value: preset },
        creditCustomPeriodFields: { classList: { toggle() {} } },
        creditPeriodFeedback: { textContent: "", classList: { toggle() {} } },
      });
      await handleCreditPeriodPresetChange();
      loadCreditOperations = originalLoad;
      return JSON.stringify(calls);
    },
    async submitCustom(start, end) {
      const calls = [];
      const feedback = { textContent: "", classList: { toggle() {} } };
      const originalLoad = loadCreditOperations;
      loadCreditOperations = async (options) => calls.push(options.periodSelection);
      Object.assign(elements, {
        creditPeriodPreset: { value: "custom" },
        creditPeriodStart: { value: start },
        creditPeriodEnd: { value: end },
        creditPeriodFeedback: feedback,
      });
      await handleCreditPeriodSubmit({ preventDefault() {} });
      loadCreditOperations = originalLoad;
      return JSON.stringify({ calls, feedback: feedback.textContent });
    },
  };`, context);
  return context.__creditPeriodHarness;
}

async function assertCreditPeriodFrontendContract() {
  const harness = loadCreditPeriodFrontendHarness();
  assert.deepStrictEqual(JSON.parse(harness.getState()), { preset: "today", start: "", end: "" });
  const now = new Date(2026, 7, 24, 15, 30, 0);
  const expectedTomorrow = new Date(2026, 7, 25).toISOString();
  const assertWindow = (preset, expectedFrom) => {
    const window = harness.getWindow(preset, "", "", now);
    assert.strictEqual(window.valid, true, `${preset} deve gerar uma janela válida`);
    assert.strictEqual(window.from, expectedFrom);
    assert.strictEqual(window.to, expectedTomorrow);
    return window;
  };

  const today = assertWindow("today", new Date(2026, 7, 24).toISOString());
  const last7days = assertWindow("last7days", new Date(2026, 7, 18).toISOString());
  assertWindow("currentMonth", new Date(2026, 7, 1).toISOString());
  assertWindow("last30days", new Date(2026, 6, 26).toISOString());
  assertWindow("currentYear", new Date(2026, 0, 1).toISOString());

  const sameDay = harness.getWindow("custom", "2026-08-24", "2026-08-24", now);
  assert.strictEqual(sameDay.valid, true);
  assert.strictEqual(sameDay.from, new Date(2026, 7, 24).toISOString());
  assert.strictEqual(sameDay.to, new Date(2026, 7, 25).toISOString());

  const customRange = harness.getWindow("custom", "2026-08-20", "2026-08-24", now);
  assert.strictEqual(customRange.valid, true);
  assert.strictEqual(customRange.from, new Date(2026, 7, 20).toISOString());
  assert.strictEqual(customRange.to, new Date(2026, 7, 25).toISOString(), "data final deve ser inclusiva na UI");
  assert.strictEqual(harness.getWindow("custom", "2026-08-25", "2026-08-24", now).valid, false);
  assert.strictEqual(harness.getWindow("custom", "", "2026-08-24", now).valid, false);

  const url = harness.buildUrl(customRange);
  assert(url.startsWith("/api/credit/operations?"));
  assert(url.includes("from=2026-08-20T"));
  assert(url.includes("%3A"), "timestamps devem estar codificados na query");
  const parsedUrl = new URL(url, "https://crm.example.com");
  assert.strictEqual(parsedUrl.searchParams.get("from"), customRange.from);
  assert.strictEqual(parsedUrl.searchParams.get("to"), customRange.to);
  assert.notStrictEqual(harness.buildUrl(today), harness.buildUrl(last7days));

  assert.deepStrictEqual(JSON.parse(harness.renderLabels("today")), {
    active: "Período: Hoje",
    metric: "CPFs coletados hoje",
  });
  assert.deepStrictEqual(JSON.parse(harness.renderLabels("last7days")), {
    active: "Período: Últimos 7 dias",
    metric: "CPFs coletados no período",
  });
  assert.deepStrictEqual(JSON.parse(harness.renderLabels("custom", "2026-08-20", "2026-08-24")), {
    active: "Período: 20/08/2026 a 24/08/2026",
    metric: "CPFs coletados no período",
  });

  const presetCalls = JSON.parse(await harness.changePreset("last7days"));
  assert.deepStrictEqual(presetCalls, [{ preset: "last7days", start: "", end: "" }]);
  assert.deepStrictEqual(JSON.parse(await harness.changePreset("custom")), []);

  const incompleteSubmit = JSON.parse(await harness.submitCustom("", "2026-08-24"));
  assert.strictEqual(incompleteSubmit.calls.length, 0, "personalizado incompleto não deve consultar");
  assert(incompleteSubmit.feedback.includes("datas inicial e final"));
  const invertedSubmit = JSON.parse(await harness.submitCustom("2026-08-25", "2026-08-24"));
  assert.strictEqual(invertedSubmit.calls.length, 0, "personalizado invertido não deve consultar");
  const validSubmit = JSON.parse(await harness.submitCustom("2026-08-20", "2026-08-24"));
  assert.deepStrictEqual(validSubmit.calls, [{ preset: "custom", start: "2026-08-20", end: "2026-08-24" }]);
}

function assertCreditOpportunityFrontendContract() {
  const harness = loadCreditPeriodFrontendHarness();
  const operations = [
    {
      conversationId: "101",
      banks: [
        { code: "001", name: "Banco Alfa", status: "available", available: true },
        { code: "033", name: "Banco Beta", status: "unavailable", available: false },
      ],
    },
    {
      conversationId: "102",
      banks: [
        { code: "033", name: "Banco Beta", status: "available", available: true },
        { code: "033", name: "Banco Beta", status: "available", available: true },
      ],
    },
    {
      conversationId: "103",
      status: "available",
      banks: [{ code: "104", name: null, status: "available", available: false }],
    },
    { conversationId: "104", banks: [] },
  ];

  assert.deepStrictEqual(JSON.parse(harness.filterOperations(operations, "all", "")), ["101", "102", "103", "104"]);
  assert.deepStrictEqual(
    JSON.parse(harness.filterOperations(operations, "available", "")),
    ["101", "102"],
    "somente available=true no banco identifica uma oportunidade"
  );
  assert.deepStrictEqual(JSON.parse(harness.filterOperations(operations, "available", "001")), ["101"]);
  assert.deepStrictEqual(JSON.parse(harness.filterOperations(operations, "available", "033")), ["102"]);
  assert.deepStrictEqual(JSON.parse(harness.bankOptions(operations)), [
    { code: "001", label: "Banco Alfa (001)", count: 1 },
    { code: "033", label: "Banco Beta (033)", count: 1 },
  ], "cada lead deve ser contado uma única vez por banco");
}

async function startMockAutoCore() {
  const state = { mode: "valid", requests: [], redirectHits: 0 };
  const server = http.createServer((req, res) => {
    state.requests.push({ url: req.url, authorization: req.headers.authorization });
    if (req.url.startsWith("/redirect-target")) {
      state.redirectHits += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(validUpstreamContract()));
      return;
    }
    if (state.mode === "redirect") {
      res.writeHead(302, { Location: "/redirect-target" });
      res.end();
      return;
    }
    if (state.mode === "upstream-error") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ token: upstreamToken, internalUrl: "http://autocore.internal", cpf: "12345678901" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(validUpstreamContract(state.mode !== "writable-contract")));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    state,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

(async () => {
  let crm;
  let mock;
  try {
    await assertCreditPeriodFrontendContract();
    assertCreditOpportunityFrontendContract();
    const gateway = require("../src/autocore-credit");
    assert.throws(() => gateway.readCreditConfig({
      CREDIT_PANEL_WRITE_ENABLED: "false",
      AUTOCORE_INTERNAL_BASE_URL: "http://user:password@127.0.0.1",
      AUTOCORE_CREDIT_OPERATIONS_TOKEN: upstreamToken,
      AUTOCORE_CREDIT_OPERATIONS_STORE_ID: "1",
    }), /central de crédito/);
    assert.throws(() => gateway.parseLimit("101"), /central de crédito/);
    assert.deepStrictEqual(gateway.validateCreditPeriod(), {});
    assert.deepStrictEqual(
      gateway.validateCreditPeriod({ from: "2026-08-14T12:00:00Z" }),
      { from: "2026-08-14T12:00:00Z" },
      "from-only com timezone Z deve ser aceito intacto"
    );
    assert.deepStrictEqual(
      gateway.validateCreditPeriod({ to: "2026-08-14T12:00:00-03:00" }),
      { to: "2026-08-14T12:00:00-03:00" },
      "to-only com timezone negativo deve ser aceito intacto"
    );
    assert.deepStrictEqual(
      gateway.validateCreditPeriod({ from: "2026-08-14T12:00:00+03:00" }),
      { from: "2026-08-14T12:00:00+03:00" },
      "timezone positivo deve ser aceito intacto"
    );
    assert.deepStrictEqual(
      gateway.validateCreditPeriod({
        from: "2026-08-14T12:00:00.123456Z",
        to: "2026-08-14T10:00:00.123457-03:00",
      }),
      {
        from: "2026-08-14T12:00:00.123456Z",
        to: "2026-08-14T10:00:00.123457-03:00",
      },
      "frações e offsets devem ser comparados e preservados"
    );
    assert.deepStrictEqual(
      gateway.validateCreditPeriod({ from: "2024-02-29T00:00:00Z" }),
      { from: "2024-02-29T00:00:00Z" },
      "data bissexta válida deve ser aceita"
    );
    for (const fraction of ["1", "123", "123456"]) {
      const from = `2026-08-14T12:00:00.${fraction}Z`;
      assert.deepStrictEqual(
        gateway.validateCreditPeriod({ from }),
        { from },
        `fração de ${fraction.length} dígito(s) deve ser aceita`
      );
    }
    const invalidPeriods = [
      { from: "" },
      { to: "   " },
      { from: "2026-08-14T12:00:00" },
      { from: "2026-02-30T12:00:00Z" },
      { from: "2026-08-14T12:00:00.1234567Z" },
      { from: "2026-08-14T12:00:00Z", to: "2026-08-14T12:00:00Z" },
      { from: "2026-08-14T12:00:00.001Z", to: "2026-08-14T12:00:00Z" },
      { from: "2026-08-14T12:00:00Z", to: "2026-08-14T09:00:00-03:00" },
    ];
    for (const period of invalidPeriods) {
      assert.throws(
        () => gateway.validateCreditPeriod(period),
        (error) => error instanceof gateway.CreditGatewayError && error.code === "INVALID_PERIOD",
        `período inválido deve produzir INVALID_PERIOD: ${JSON.stringify(period)}`
      );
    }
    assert.throws(() => gateway.readCreditConfig({
      CREDIT_PANEL_WRITE_ENABLED: "true",
      AUTOCORE_INTERNAL_BASE_URL: "http://127.0.0.1",
      AUTOCORE_CREDIT_OPERATIONS_TOKEN: upstreamToken,
      AUTOCORE_CREDIT_OPERATIONS_STORE_ID: "1",
    }), /central de crédito/, "write enabled deve falhar fechado");

    const gatewayEnv = {
      CREDIT_PANEL_WRITE_ENABLED: "false",
      AUTOCORE_INTERNAL_BASE_URL: "http://127.0.0.1:8080",
      AUTOCORE_CREDIT_OPERATIONS_TOKEN: upstreamToken,
      AUTOCORE_CREDIT_OPERATIONS_STORE_ID: "7",
    };
    const gatewayRequests = [];
    const recordingHttpClient = {
      async get(url, options) {
        gatewayRequests.push({ url, options });
        return { data: validUpstreamContract() };
      },
    };
    await gateway.fetchCreditOperations({ limit: 17, env: gatewayEnv, httpClient: recordingHttpClient });
    assert.deepStrictEqual(
      gatewayRequests.at(-1).options.params,
      { store_id: 7, limit: 17 },
      "gateway legado não deve incluir from/to ausentes"
    );
    await gateway.fetchCreditOperations({
      limit: 17,
      from: "2026-08-14T12:00:00Z",
      env: gatewayEnv,
      httpClient: recordingHttpClient,
    });
    assert.deepStrictEqual(
      gatewayRequests.at(-1).options.params,
      { store_id: 7, limit: 17, from: "2026-08-14T12:00:00Z" },
      "gateway deve incluir somente from quando to estiver ausente"
    );
    await gateway.fetchCreditOperations({
      limit: 17,
      to: "2026-08-14T12:00:00-03:00",
      env: gatewayEnv,
      httpClient: recordingHttpClient,
    });
    assert.deepStrictEqual(
      gatewayRequests.at(-1).options.params,
      { store_id: 7, limit: 17, to: "2026-08-14T12:00:00-03:00" },
      "gateway deve incluir somente to quando from estiver ausente"
    );
    await gateway.fetchCreditOperations({
      limit: 17,
      from: "2026-08-14T12:00:00.123Z",
      to: "2026-08-14T13:00:00.456Z",
      env: gatewayEnv,
      httpClient: recordingHttpClient,
    });
    assert.deepStrictEqual(
      gatewayRequests.at(-1).options.params,
      {
        store_id: 7,
        limit: 17,
        from: "2026-08-14T12:00:00.123Z",
        to: "2026-08-14T13:00:00.456Z",
      },
      "gateway deve encaminhar a janela completa intacta"
    );

    const db = require("../src/db");
    assert.strictEqual(db.bootstrapFromEnv("https://chat.example.com").bootstrapped, true);
    const admin = db.authenticate("admin-credit@example.com", "admin-credit-123");
    const organizationId = admin.organization_id;
    const sessions = { admin: db.createSession(admin, 60_000).rawToken };
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
        organizationId, actorUserId: admin.id, name: `Perfil ${profile.role}`,
        email: `${profile.role}-credit@example.com`, password: temporaryPassword,
        operationalRole: profile.role, chatwootAgentId: profile.agentId, visibilityScope: profile.scope,
      });
      db.changeOwnPassword({
        organizationId, userId: user.id, newPassword: permanentPassword,
        newPasswordConfirmation: permanentPassword,
      });
      sessions[profile.role] = db.createSession(db.authenticate(user.email, permanentPassword), 60_000).rawToken;
    }
    const expectedPermissions = { admin: true, manager: true, sdr: true, seller: false, agent: false, viewer: false };
    for (const [role, allowed] of Object.entries(expectedPermissions)) {
      assert.strictEqual(db.getSession(sessions[role]).permissions.includes("credit:monitor"), allowed);
    }
    db.closeDatabase();

    mock = await startMockAutoCore();
    crm = await startCrm({
      CREDIT_PANEL_ENABLED: "false",
      AUTOCORE_INTERNAL_BASE_URL: mock.baseUrl,
      AUTOCORE_CREDIT_OPERATIONS_TOKEN: upstreamToken,
      AUTOCORE_CREDIT_OPERATIONS_STORE_ID: "7",
    });
    let response = await requestCreditOperations(crm.baseUrl);
    assert.strictEqual(response.status, 401);
    for (const role of ["admin", "manager", "sdr"]) {
      response = await requestCreditOperations(crm.baseUrl, sessions[role]);
      assert.strictEqual(response.status, 200, `${role} deve acessar o endpoint`);
      assert.deepStrictEqual(response.body, expectedDisabledContract);
    }
    for (const role of ["seller", "agent", "viewer"]) {
      response = await requestCreditOperations(crm.baseUrl, sessions[role]);
      assert.strictEqual(response.status, 403, `${role} não deve acessar o endpoint`);
    }
    assert.strictEqual(mock.state.requests.length, 0, "painel disabled não deve chamar AutoCore");
    await stopServer(crm.child);

    crm = await startCrm({
      CREDIT_PANEL_ENABLED: "true",
      AUTOCORE_INTERNAL_BASE_URL: "",
      AUTOCORE_CREDIT_OPERATIONS_TOKEN: upstreamToken,
      AUTOCORE_CREDIT_OPERATIONS_STORE_ID: "7",
    });
    response = await requestCreditOperations(crm.baseUrl, sessions.admin);
    assert.strictEqual(response.status, 503, "config inválida deve falhar fechada");
    assert.deepStrictEqual(response.body, { error: "Não foi possível consultar a central de crédito" });
    await stopServer(crm.child);

    crm = await startCrm({
      CREDIT_PANEL_ENABLED: "true",
      CREDIT_PANEL_WRITE_ENABLED: "false",
      AUTOCORE_INTERNAL_BASE_URL: mock.baseUrl,
      AUTOCORE_CREDIT_OPERATIONS_TOKEN: upstreamToken,
      AUTOCORE_CREDIT_OPERATIONS_STORE_ID: "7",
      AUTOCORE_CREDIT_OPERATIONS_TIMEOUT_MS: "2000",
    });
    mock.state.mode = "valid";
    response = await requestCreditOperations(
      crm.baseUrl,
      sessions.admin,
      `?limit=17&store_id=999&token=${encodeURIComponent(upstreamToken)}`
    );
    assert.strictEqual(response.status, 200);
    const captured = mock.state.requests.at(-1);
    const capturedUrl = new URL(captured.url, mock.baseUrl);
    assert.strictEqual(captured.authorization, `Bearer ${upstreamToken}`);
    assert.strictEqual(capturedUrl.pathname, "/internal/credit/operations");
    assert.strictEqual(capturedUrl.searchParams.get("store_id"), "7");
    assert.strictEqual(capturedUrl.searchParams.get("limit"), "17");
    assert.deepStrictEqual(
      [...capturedUrl.searchParams.keys()].sort(),
      ["limit", "store_id"],
      "requisição legada deve manter exatamente store_id e limit"
    );
    assert.strictEqual(response.body.storeId, 7);
    assert.strictEqual(response.body.readOnly, true);
    assert.strictEqual(response.body.items[0].cpfLast4, "4725");
    assert.strictEqual(Object.hasOwn(response.body.items[1], "cpfLast4"), false);
    assert.strictEqual(response.body.items[0].banks[0].available, null);
    assert.deepStrictEqual(response.body.items[0].facts.downPayment, { known: false, cents: null });
    assert.deepStrictEqual(response.body.items[1].facts.downPayment, { known: true, cents: 0 });

    const serialized = JSON.stringify(response.body);
    assert.strictEqual(findForbiddenKey(response.body, new Set([
      "cpf", "phone", "email", "birthdate", "cnh", "payload_json", "pre_approval_status", "tokens", "secrets",
    ])), null, "campos inesperados de PII e payload devem ser descartados");
    for (const forbidden of [
      upstreamToken, "12345678901", "+5565999999999", "pessoa@example.com", "1990-01-01",
      "12345678900", "raw-job-payload", "approved-secret", "payload_json", "pre_approval_status", "secrets",
    ]) assert.strictEqual(serialized.includes(forbidden), false, `resposta não pode conter ${forbidden}`);

    const fromOnly = "2026-08-14T12:00:00Z";
    response = await requestCreditOperations(
      crm.baseUrl,
      sessions.admin,
      `?from=${encodeURIComponent(fromOnly)}`
    );
    assert.strictEqual(response.status, 200);
    const fromOnlyUrl = new URL(mock.state.requests.at(-1).url, mock.baseUrl);
    assert.strictEqual(fromOnlyUrl.searchParams.get("from"), fromOnly);
    assert.strictEqual(fromOnlyUrl.searchParams.has("to"), false);

    const toOnly = "2026-08-14T15:00:00+03:00";
    response = await requestCreditOperations(
      crm.baseUrl,
      sessions.admin,
      `?to=${encodeURIComponent(toOnly)}`
    );
    assert.strictEqual(response.status, 200);
    const toOnlyUrl = new URL(mock.state.requests.at(-1).url, mock.baseUrl);
    assert.strictEqual(toOnlyUrl.searchParams.has("from"), false);
    assert.strictEqual(toOnlyUrl.searchParams.get("to"), toOnly);

    const validFrom = "2026-08-14T12:00:00.123456Z";
    const validTo = "2026-08-14T10:00:00.654321-03:00";
    response = await requestCreditOperations(
      crm.baseUrl,
      sessions.admin,
      `?limit=17&from=${encodeURIComponent(validFrom)}&to=${encodeURIComponent(validTo)}`
    );
    assert.strictEqual(response.status, 200);
    const periodUrl = new URL(mock.state.requests.at(-1).url, mock.baseUrl);
    assert.strictEqual(periodUrl.searchParams.get("store_id"), "7");
    assert.strictEqual(periodUrl.searchParams.get("limit"), "17");
    assert.strictEqual(periodUrl.searchParams.get("from"), validFrom);
    assert.strictEqual(periodUrl.searchParams.get("to"), validTo);
    assert.deepStrictEqual(
      [...periodUrl.searchParams.keys()].sort(),
      ["from", "limit", "store_id", "to"],
      "período válido deve ser encaminhado sem parâmetros extras"
    );

    const callsBeforeInvalidPeriod = mock.state.requests.length;
    response = await requestCreditOperations(crm.baseUrl, sessions.admin, "?from=");
    assert.strictEqual(response.status, 400);
    assert.deepStrictEqual(response.body, { error: "Período inválido" });
    response = await requestCreditOperations(
      crm.baseUrl,
      sessions.admin,
      "?from=2026-08-14T12%3A00%3A00"
    );
    assert.strictEqual(response.status, 400);
    assert.deepStrictEqual(response.body, { error: "Período inválido" });
    assert.strictEqual(
      mock.state.requests.length,
      callsBeforeInvalidPeriod,
      "período inválido não deve alcançar o AutoCore"
    );

    const callsBeforeInvalidLimit = mock.state.requests.length;
    response = await requestCreditOperations(crm.baseUrl, sessions.admin, "?limit=0");
    assert.strictEqual(response.status, 400);
    assert.strictEqual(mock.state.requests.length, callsBeforeInvalidLimit);

    mock.state.mode = "redirect";
    response = await requestCreditOperations(crm.baseUrl, sessions.admin);
    assert.strictEqual(response.status, 503);
    assert.strictEqual(mock.state.redirectHits, 0, "redirect upstream não deve ser seguido");

    mock.state.mode = "writable-contract";
    response = await requestCreditOperations(crm.baseUrl, sessions.admin);
    assert.strictEqual(response.status, 503, "readOnly=false deve ser rejeitado");

    mock.state.mode = "upstream-error";
    response = await requestCreditOperations(crm.baseUrl, sessions.admin);
    assert.strictEqual(response.status, 503);
    assert.deepStrictEqual(response.body, { error: "Não foi possível consultar a central de crédito" });
    assert.strictEqual(JSON.stringify(response.body).includes(upstreamToken), false);

    const html = fs.readFileSync(path.join(root, "src", "index.html"), "utf8");
    const script = fs.readFileSync(path.join(root, "src", "script.js"), "utf8");
    const serverSource = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");
    assert(html.includes('id="credit-nav-item" class="nav-item is-hidden" data-view="credit"'));
    assert(html.includes('id="credit-operation-drawer" class="drawer credit-detail-drawer"'));
    assert(html.includes("SOMENTE LEITURA"));
    assert(html.includes('<option value="today" selected>Hoje</option>'));
    for (const id of [
      "credit-period-form", "credit-period-preset", "credit-custom-period-fields",
      "credit-period-start", "credit-period-end", "credit-period-apply", "credit-period-active",
      "credit-queue-filters", "credit-filter-all", "credit-filter-available",
      "credit-filter-all-count", "credit-filter-available-count", "credit-bank-filter-group",
      "credit-bank-filters", "credit-filter-summary",
    ]) assert(html.includes(`id="${id}"`), `controle ${id} deve existir`);
    assert(script.includes("apiRequest(buildCreditOperationsUrl(periodWindow))"));
    assert(script.includes('elements.creditPeriodPreset?.addEventListener("change", handleCreditPeriodPresetChange)'));
    assert(script.includes('button.addEventListener("click", () => selectCreditOpportunityFilter'));
    assert(script.includes("bank?.available === true"));
    assert(script.includes("function selectCreditBankFilter(bankCode)"));
    assert(script.includes('"CPFs coletados hoje"'));
    assert(script.includes('"CPFs coletados no período"'));
    assert(script.includes('"Nenhuma análise disponível ainda."'));
    assert(script.includes('"Não foi possível carregar a central de crédito."'));
    assert(script.includes("function openCreditOperationDetail(operation)"));
    assert(script.includes("credit-operation-row"));
    assert.strictEqual(/app\.(post|put|patch|delete)\(\s*["']\/api\/credit\//i.test(serverSource), false);

    console.log("CRM credit operations read-only gateway, RBAC, PII and UI tests: OK");
  } finally {
    await stopServer(crm?.child);
    if (mock) await mock.close();
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
