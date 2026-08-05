const DEFAULT_PIPELINE_STAGES = [
  { id: "new", label: "Novo lead", color: "#2563eb", archived: false, locked: true },
  { id: "contacted", label: "Contato iniciado", color: "#0ea5e9", archived: false },
  { id: "qualification", label: "Qualificação", color: "#8b5cf6", archived: false },
  { id: "proposal", label: "Proposta", color: "#f59e0b", archived: false },
  { id: "negotiation", label: "Negociação", color: "#f97316", archived: false },
  { id: "won", label: "Ganho", color: "#10b981", archived: false, locked: true, terminal: true },
  { id: "lost", label: "Perdido", color: "#ef4444", archived: false, locked: true, terminal: true },
];

const STORAGE_KEYS = {
  activePreset: "chatwoot_crm_active_filter_preset_v13",
  legacyStages: "chatwoot_crm_pipeline_stages_v12",
  legacyFilters: "chatwoot_crm_filter_presets_v12",
  legacyMigrationDone: "chatwoot_crm_v13_legacy_migration_done",
};

const PAGE_SIZE = 25;
const INTERVENTION_LABELS = new Set(["precisa-humano", "atendimento-manual"]);

const state = {
  accountId: null,
  organization: null,
  user: null,
  permissions: [],
  users: [],
  audit: [],
  conversations: [],
  agents: [],
  teams: [],
  inboxes: [],
  labels: [],
  pipelineStages: [],
  filterPresets: [],
  activeFilterPresetId: "",
  currentView: "dashboard",
  currentConversationId: null,
  search: "",
  filters: {
    assignee: "",
    team: "",
    inbox: "",
    label: "",
    priority: "",
    taskStatus: "",
  },
  taskViewFilter: "all",
  draggingConversationId: null,
  pendingTransition: null,
  lastSyncAt: null,
  refreshTimer: null,
  syncStatusTimer: null,
  isLoadingWorkspace: false,
  labelDraft: new Set(),
  interventionFilter: "all",
  interventionCount: 0,
  organizationConversationCount: 0,
  currentMessages: [],
  showSystemEvents: false,
};

const elements = {};

function byId(id) {
  return document.getElementById(id);
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function cloneDefaultStages() {
  return DEFAULT_PIPELINE_STAGES.map((stage) => ({ ...stage }));
}

function loadJsonStorage(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (error) {
    console.warn(`Configuração local inválida em ${key}:`, error);
    return fallback;
  }
}

function slugifyStage(value) {
  return safeLower(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 42);
}

function normalizePipelineStages(stages) {
  const source = Array.isArray(stages) && stages.length ? stages : cloneDefaultStages();
  const normalized = [];
  const ids = new Set();
  for (const stage of source) {
    const id = slugifyStage(stage?.id || stage?.label || "");
    if (!id || ids.has(id)) continue;
    ids.add(id);
    normalized.push({
      id,
      label: String(stage?.label || id).trim().slice(0, 60) || id,
      color: /^#[0-9a-f]{6}$/i.test(String(stage?.color || "")) ? stage.color : "#64748b",
      archived: Boolean(stage?.archived),
      locked: Boolean(stage?.locked || ["new", "won", "lost"].includes(id)),
      terminal: Boolean(stage?.terminal || ["won", "lost"].includes(id)),
    });
  }
  for (const required of DEFAULT_PIPELINE_STAGES.filter((stage) => stage.locked)) {
    if (!ids.has(required.id)) normalized.push({ ...required });
  }
  return normalized;
}

function loadLocalConfiguration() {
  state.pipelineStages = cloneDefaultStages();
  state.filterPresets = [];
  state.activeFilterPresetId = window.localStorage.getItem(STORAGE_KEYS.activePreset) || "";
}

function hasPermission(permission) {
  return state.permissions.includes(permission);
}

function applySessionPayload(payload) {
  state.accountId = Number(payload.accountId);
  state.organization = payload.organization || null;
  state.user = payload.user || null;
  state.permissions = Array.isArray(payload.permissions) ? payload.permissions : [];
}

async function savePipelineStages(options = {}) {
  const response = await apiRequest("/api/crm/stages/save", {
    method: "POST",
    body: JSON.stringify({ stages: state.pipelineStages }),
  });
  state.pipelineStages = normalizePipelineStages(response.stages || state.pipelineStages);
  if (!response.stageSync?.ok && !options.silent) {
    showToast("Etapas centralizadas, mas a sincronização com o Chatwoot precisa ser revisada.", "error");
  }
  return response;
}

function getAllPipelineStages() {
  return state.pipelineStages.length ? state.pipelineStages : cloneDefaultStages();
}

function getVisiblePipelineStages() {
  return getAllPipelineStages().filter((stage) => !stage.archived);
}

function getStage(stageId) {
  return getAllPipelineStages().find((stage) => stage.id === stageId) || getAllPipelineStages()[0];
}

function getSender(conversation) {
  return conversation?.meta?.sender || conversation?.sender || {};
}

function getAssignee(conversation) {
  return conversation?.meta?.assignee || conversation?.assignee || null;
}

function getTeam(conversation) {
  return conversation?.meta?.team || conversation?.team || null;
}

function getInbox(conversation) {
  const inboxId = Number(conversation?.inbox_id || conversation?.inbox?.id || 0);
  if (!inboxId) return conversation?.inbox || null;
  return (
    state.inboxes.find((inbox) => Number(inbox.id) === inboxId) ||
    conversation?.inbox ||
    null
  );
}

function getLabelTitle(label) {
  return String(label?.title || label?.name || label || "").trim();
}

function getLabels(conversation) {
  const labels = conversation?.labels || conversation?.label_list || [];
  if (!Array.isArray(labels)) return [];
  return [...new Set(labels.map(getLabelTitle).filter(Boolean))];
}

function getAssigneeId(conversation) {
  const id = Number(getAssignee(conversation)?.id || conversation?.assignee_id || 0);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function interventionLabels(conversation) {
  return getLabels(conversation).filter((label) => INTERVENTION_LABELS.has(safeLower(label)));
}

function isIntervention(conversation) {
  return interventionLabels(conversation).length > 0;
}

function isMine(conversation) {
  const linkedAgentId = Number(state.user?.chatwootAgentId || 0);
  return linkedAgentId > 0 && getAssigneeId(conversation) === linkedAgentId;
}

function belongsToCurrentScope(conversation) {
  const scope = state.user?.visibilityScope || "all";
  if (scope === "all") return true;
  const assigneeId = getAssigneeId(conversation);
  const linkedAgentId = Number(state.user?.chatwootAgentId || 0);
  if (scope === "mine") return linkedAgentId > 0 && assigneeId === linkedAgentId;
  if (scope === "unassigned_and_mine") {
    return !assigneeId || (linkedAgentId > 0 && assigneeId === linkedAgentId);
  }
  if (scope === "unassigned") return !assigneeId;
  return false;
}

function operationalStageIds() {
  const role = state.user?.operationalRole || state.user?.role;
  if (role === "sdr") return new Set(["new", "contacted", "qualification"]);
  if (role === "seller") return new Set(["proposal", "negotiation", "won", "lost"]);
  return new Set(getVisiblePipelineStages().map((stage) => stage.id));
}

function getOperationalPipelineStages() {
  const allowed = operationalStageIds();
  return getVisiblePipelineStages().filter((stage) => allowed.has(stage.id));
}

function todayKey() {
  const date = new Date();
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function operationalPriority(conversation) {
  if (isIntervention(conversation)) return 0;
  const taskStatus = getTaskStatus(conversation);
  if (taskStatus === "overdue") return 1;
  const attributes = getCustomAttributes(conversation);
  if (taskStatus === "pending" && attributes.crm_task_due_at === todayKey()) return 2;
  if (!getAssigneeId(conversation)) return 3;
  if (Date.now() - conversationActivityTimestamp(conversation) >= 24 * 60 * 60 * 1000) return 4;
  if (!String(attributes.crm_next_task || "").trim()) return 5;
  return 6;
}

function sortOperationalQueue(conversations) {
  return [...conversations].sort((a, b) => {
    const priority = operationalPriority(a) - operationalPriority(b);
    if (priority !== 0) return priority;
    return conversationActivityTimestamp(b) - conversationActivityTimestamp(a);
  });
}

function focusReason(conversation) {
  if (isIntervention(conversation)) return "Intervenção humana";
  const taskStatus = getTaskStatus(conversation);
  if (taskStatus === "overdue") return "Tarefa vencida";
  const attributes = getCustomAttributes(conversation);
  if (taskStatus === "pending" && attributes.crm_task_due_at === todayKey()) return "Retorno para hoje";
  if (!getAssigneeId(conversation)) return "Sem responsável";
  if (Date.now() - conversationActivityTimestamp(conversation) >= 24 * 60 * 60 * 1000) return "Lead parado";
  if (!String(attributes.crm_next_task || "").trim()) return "Sem próxima tarefa";
  return "Acompanhar oportunidade";
}

function normalizeLabelColor(value) {
  const color = String(value || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(color)) {
    return `#${color.slice(1).split("").map((character) => `${character}${character}`).join("")}`.toUpperCase();
  }
  return "#64748B";
}

function getLabelDefinition(labelName) {
  const key = safeLower(labelName);
  const definition = state.labels.find((label) => safeLower(getLabelTitle(label)) === key);
  return definition && typeof definition === "object"
    ? definition
    : { title: labelName, description: "", color: "#64748B" };
}

function labelTextColor(backgroundColor) {
  const color = normalizeLabelColor(backgroundColor).slice(1);
  const channels = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  const contrastWithBlack = (luminance + 0.05) / 0.05;
  const contrastWithWhite = 1.05 / (luminance + 0.05);
  return contrastWithBlack >= contrastWithWhite ? "#111827" : "#FFFFFF";
}

function createLabelChip(labelName, options = {}) {
  const definition = getLabelDefinition(labelName);
  const title = getLabelTitle(definition) || String(labelName);
  const color = normalizeLabelColor(definition.color);
  const chip = createElement(
    "span",
    `label-chip${options.compact ? " label-chip-compact" : ""}`,
    title
  );
  chip.style.setProperty("--label-bg", color);
  chip.style.setProperty("--label-fg", labelTextColor(color));
  chip.style.borderColor = color;
  chip.title = definition.description ? `${title} — ${definition.description}` : title;
  return chip;
}

function getCustomAttributes(conversation) {
  return conversation?.custom_attributes && typeof conversation.custom_attributes === "object"
    ? conversation.custom_attributes
    : {};
}

function getConversationStage(conversation) {
  const customStage = String(getCustomAttributes(conversation).crm_stage || "").trim();
  if (getAllPipelineStages().some((stage) => stage.id === customStage)) return customStage;

  const labels = getLabels(conversation).map((label) => String(label).toLowerCase());
  if (labels.some((label) => ["ganho", "won", "venda-fechada"].includes(label))) return "won";
  if (labels.some((label) => ["perdido", "lost", "sem-interesse"].includes(label))) return "lost";
  return "new";
}

function getLastMessage(conversation) {
  if (conversation?.last_non_activity_message?.content) {
    return conversation.last_non_activity_message.content;
  }

  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  const message = messages[messages.length - 1];
  return message?.content || message?.processed_message_content || "Sem mensagens";
}

function getTimestamp(value) {
  if (!value) return null;
  if (typeof value === "number") return value > 1000000000000 ? value : value * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function conversationActivityTimestamp(conversation) {
  return (
    getTimestamp(conversation?.last_activity_at) ||
    getTimestamp(conversation?.updated_at) ||
    getTimestamp(conversation?.created_at) ||
    0
  );
}

function formatDate(value, options = {}) {
  let timestamp = null;
  if (options.dateOnly && /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) {
    const [year, month, day] = String(value).split("-").map(Number);
    timestamp = new Date(year, month - 1, day, 12, 0, 0).getTime();
  } else {
    timestamp = getTimestamp(value);
  }
  if (!timestamp) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: options.withYear === false ? undefined : "numeric",
    hour: options.dateOnly ? undefined : "2-digit",
    minute: options.dateOnly ? undefined : "2-digit",
  }).format(new Date(timestamp));
}

function formatRelativeTime(value) {
  const timestamp = getTimestamp(value);
  if (!timestamp) return "Sem atividade";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return "Agora";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} d`;
}

function parseCurrency(value) {
  if (value === null || value === undefined || value === "") return 0;
  const normalized = String(value).replace(/[^0-9,.-]/g, "").replace(",", ".");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function formatCurrency(value) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 2,
  }).format(parseCurrency(value));
}

function safeLower(value) {
  return String(value || "").toLocaleLowerCase("pt-BR");
}

function isOverdue(dateValue, done = false) {
  if (!dateValue || done) return false;
  const due = new Date(`${dateValue}T23:59:59`);
  return Number.isFinite(due.getTime()) && due.getTime() < Date.now();
}

function isTrue(value) {
  return value === true || String(value || "").toLowerCase() === "true";
}

function getTaskStatus(conversation) {
  const attributes = getCustomAttributes(conversation);
  if (!String(attributes.crm_next_task || "").trim()) return "none";
  if (isTrue(attributes.crm_task_done)) return "done";
  if (isOverdue(attributes.crm_task_due_at, false)) return "overdue";
  return "pending";
}

function taskStatusLabel(status) {
  return {
    none: "Sem tarefa",
    pending: "Pendente",
    overdue: "Vencida",
    done: "Concluída",
  }[status] || "Sem tarefa";
}

function priorityLabel(priority) {
  return {
    none: "Sem prioridade",
    low: "Baixa",
    medium: "Média",
    high: "Alta",
    urgent: "Urgente",
  }[priority || "none"] || priority || "Sem prioridade";
}

function idleClass(conversation) {
  const timestamp = conversationActivityTimestamp(conversation);
  if (!timestamp) return "";
  const hours = (Date.now() - timestamp) / 3600000;
  if (hours >= 24) return "idle-critical";
  if (hours >= 4) return "idle-warning";
  return "idle-ok";
}

function updateSyncStatus() {
  if (!elements.lastSync) return;
  if (!state.lastSyncAt) {
    elements.lastSync.textContent = "Aguardando sincronização";
    return;
  }
  elements.lastSync.textContent = `Atualizado ${formatRelativeTime(state.lastSyncAt).toLowerCase()}`;
  elements.lastSync.title = formatDate(state.lastSyncAt);
}

function setLoading(isLoading, message = "Carregando dados...") {
  elements.loadingMessage.textContent = message;
  elements.loadingOverlay.classList.toggle("is-hidden", !isLoading);
}

function showToast(message, type = "default") {
  const toast = createElement("div", `toast ${type}`, message);
  elements.toastContainer.appendChild(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  if (response.status === 204) return null;

  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message =
      body?.error ||
      body?.message ||
      (typeof body === "string" ? body : `Erro HTTP ${response.status}`);
    const error = new Error(message);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

async function maybeMigrateLegacyConfiguration() {
  if (window.localStorage.getItem(STORAGE_KEYS.legacyMigrationDone) === "1") return;
  const legacyStages = loadJsonStorage(STORAGE_KEYS.legacyStages, null);
  const legacyFilters = loadJsonStorage(STORAGE_KEYS.legacyFilters, []);
  const hasStages = Array.isArray(legacyStages) && legacyStages.length >= 3;
  const hasFilters = Array.isArray(legacyFilters) && legacyFilters.length > 0;
  if (!hasStages && !hasFilters) {
    window.localStorage.setItem(STORAGE_KEYS.legacyMigrationDone, "1");
    return;
  }
  const canMigrateStages = hasStages && hasPermission("pipeline:manage");
  const confirmed = window.confirm(
    "Encontramos configurações da V1.2 neste navegador. Deseja migrar etapas e filtros para a base central da equipe?"
  );
  if (!confirmed) {
    window.localStorage.setItem(STORAGE_KEYS.legacyMigrationDone, "1");
    return;
  }
  try {
    if (canMigrateStages) {
      state.pipelineStages = normalizePipelineStages(legacyStages);
      await savePipelineStages({ silent: true });
    }
    for (const legacy of legacyFilters) {
      const name = String(legacy?.name || "Filtro migrado").trim().slice(0, 60);
      const snapshot = {
        search: String(legacy?.search || ""),
        filters: legacy?.filters && typeof legacy.filters === "object" ? legacy.filters : {},
      };
      try {
        const result = await apiRequest("/api/crm/filters", {
          method: "POST",
          body: JSON.stringify({ name, scope: "personal", snapshot }),
        });
        state.filterPresets.push(result.preset);
      } catch (error) {
        console.warn(`Filtro legado não migrado (${name}):`, error.message);
      }
    }
    window.localStorage.setItem(STORAGE_KEYS.legacyMigrationDone, "1");
    showToast("Configurações da V1.2 migradas para a base central.", "success");
  } catch (error) {
    showToast(`Não foi possível concluir a migração: ${error.message}`, "error");
  }
}

async function loadCentralConfiguration(options = {}) {
  const config = await apiRequest("/api/crm/config");
  applySessionPayload(config);
  state.pipelineStages = normalizePipelineStages(config.pipeline?.stages || cloneDefaultStages());
  state.filterPresets = Array.isArray(config.filterPresets) ? config.filterPresets : [];
  if (!options.skipLegacyMigration) await maybeMigrateLegacyConfiguration();
  if (!state.filterPresets.some((item) => item.id === state.activeFilterPresetId)) {
    state.activeFilterPresetId = "";
    window.localStorage.removeItem(STORAGE_KEYS.activePreset);
  }
  if (!options.skipRender) {
    renderFilterPresets();
    renderStageManager();
    populateDrawerOptions();
    renderIdentity();
  }
  if (hasPermission("users:manage") || hasPermission("audit:read")) {
    await loadAdministrationData({ silent: true });
  }
  return config;
}

function renderIdentity() {
  if (!state.user || !state.organization) return;
  elements.sidebarAccountId.textContent = `${state.organization.name} · Conta ${state.accountId}`;
  elements.settingsAccountId.textContent = String(state.accountId);
  if (elements.settingsOrganizationName) elements.settingsOrganizationName.textContent = state.organization.name;
  if (elements.settingsCurrentUser) {
    elements.settingsCurrentUser.textContent = `${state.user.name} · ${roleLabel(state.user.operationalRole || state.user.role)}`;
  }
  if (elements.sidebarUserName) elements.sidebarUserName.textContent = state.user.name;
  if (elements.sidebarUserRole) {
    elements.sidebarUserRole.textContent = roleLabel(state.user.operationalRole || state.user.role);
  }
  if (elements.settingsCurrentScope) {
    elements.settingsCurrentScope.textContent = scopeLabel(state.user.visibilityScope);
  }
  if (elements.settingsLinkedAgent) {
    const agent = state.agents.find(
      (item) => Number(item.id) === Number(state.user.chatwootAgentId)
    );
    elements.settingsLinkedAgent.textContent = agent?.name || (state.user.chatwootAgentId ? `Agente #${state.user.chatwootAgentId}` : "Não vinculado");
  }
  elements.pipelineSettingsPanel?.classList.toggle("is-readonly", !hasPermission("pipeline:manage"));
  elements.userManagementPanel?.classList.toggle("is-hidden", !hasPermission("users:manage"));
  elements.auditPanel?.classList.toggle("is-hidden", !hasPermission("audit:read"));
  elements.bootstrapCrm.disabled = !hasPermission("pipeline:manage");
  elements.managePipeline.disabled = !hasPermission("pipeline:manage");
  elements.saveOpportunity.disabled = !hasPermission("opportunities:write");
  if (elements.saveLabels) elements.saveLabels.disabled = !hasPermission("opportunities:write");
  elements.replySubmit.disabled = !hasPermission("messages:send");
}

function roleLabel(role) {
  return {
    admin: "Administrador",
    manager: "Gerente",
    sdr: "SDR",
    seller: "Vendedor",
    agent: "Atendente",
    viewer: "Somente leitura",
  }[role] || role || "Usuário";
}

function scopeLabel(scope, operationalRole = state.user?.operationalRole) {
  if (operationalRole === "sdr") {
    return {
      all: "Todos os leads",
      mine: "Somente meus leads",
      unassigned_and_mine: "Fila SDR + meus leads",
      unassigned: "Somente fila SDR sem responsável",
    }[scope] || scope || "Não configurado";
  }
  return {
    all: "Todos os leads",
    mine: "Somente meus leads",
    unassigned_and_mine: "Sem responsável + meus leads",
    unassigned: "Somente leads sem responsável",
  }[scope] || scope || "Não configurado";
}

async function initializeSession() {
  try {
    const session = await apiRequest("/api/session");
    if (session.connected) {
      applySessionPayload(session);
      showApplication();
      await loadCentralConfiguration({ skipRender: true });
      renderIdentity();
      await loadWorkspace({ skipCentralReload: true });
      return;
    }
  } catch (error) {
    console.error("Falha ao verificar sessão:", error);
  }
  showLogin();
}

function showLogin() {
  elements.loginScreen.classList.remove("is-hidden");
  elements.app.classList.add("is-hidden");
}

function showApplication() {
  elements.loginScreen.classList.add("is-hidden");
  elements.app.classList.remove("is-hidden");
  renderIdentity();
}

async function handleLogin(event) {
  event.preventDefault();
  elements.loginError.textContent = "";
  elements.loginSubmit.disabled = true;
  elements.loginSubmit.textContent = "Entrando...";

  try {
    const email = elements.loginEmail.value.trim();
    const password = elements.loginPassword.value;
    const response = await apiRequest("/api/session", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    applySessionPayload(response);
    elements.loginPassword.value = "";
    showApplication();
    await loadCentralConfiguration({ skipRender: true });
    renderIdentity();
    await loadWorkspace({ skipCentralReload: true });
  } catch (error) {
    elements.loginError.textContent = error.message;
  } finally {
    elements.loginSubmit.disabled = false;
    elements.loginSubmit.textContent = "Entrar no CRM";
  }
}

async function logout() {
  try {
    await apiRequest("/api/session", { method: "DELETE" });
  } finally {
    state.accountId = null;
    state.organization = null;
    state.user = null;
    state.permissions = [];
    state.conversations = [];
    showLogin();
  }
}

async function fetchAllConversations() {
  return apiRequest("/api/crm/workspace/conversations");
}

async function loadWorkspace(options = {}) {
  const background = options.background === true;
  if (state.isLoadingWorkspace) return;
  state.isLoadingWorkspace = true;
  if (!background) setLoading(true, "Sincronizando conversas e equipe...");
  elements.refreshButton?.classList.add("is-spinning");
  try {
    if (!options.skipCentralReload) {
      await loadCentralConfiguration({ skipRender: true });
      renderIdentity();
    }
    const [conversationResult, agents, teams, inboxData, labelsData] = await Promise.all([
      fetchAllConversations(),
      apiRequest(`/api/v1/accounts/${state.accountId}/agents`).catch(() => []),
      apiRequest(`/api/v1/accounts/${state.accountId}/teams`).catch(() => []),
      apiRequest(`/api/v1/accounts/${state.accountId}/inboxes`).catch(() => ({ payload: [] })),
      apiRequest(`/api/v1/accounts/${state.accountId}/labels`).catch(() => ({ payload: [] })),
    ]);

    const conversations = Array.isArray(conversationResult?.conversations)
      ? conversationResult.conversations
      : [];
    state.conversations = sortOperationalQueue(conversations);
    state.interventionCount = Number(conversationResult?.interventionCount || 0);
    state.organizationConversationCount = Number(
      conversationResult?.totalOrganization || conversations.length
    );
    state.agents = Array.isArray(agents) ? agents : agents?.payload || [];
    state.teams = Array.isArray(teams) ? teams : teams?.payload || [];
    state.inboxes = Array.isArray(inboxData) ? inboxData : inboxData?.payload || [];
    state.labels = Array.isArray(labelsData) ? labelsData : labelsData?.payload || [];

    if (hasPermission("users:manage")) renderUsers();
    renderIdentity();
    populateFilterOptions();
    populateDrawerOptions();
    populateUserAgentOptions();
    restoreActiveFilterPreset();
    renderFilterPresets();
    renderStageManager();
    state.lastSyncAt = Date.now();
    updateSyncStatus();
    renderAll();
  } catch (error) {
    if (error.status === 401) {
      showToast("Sua sessão expirou. Conecte novamente.", "error");
      showLogin();
      return;
    }
    console.error(error);
    showToast(`Erro ao carregar dados: ${error.message}`, "error");
  } finally {
    state.isLoadingWorkspace = false;
    elements.refreshButton?.classList.remove("is-spinning");
    if (!background) setLoading(false);
  }
}

function filteredConversations() {
  const search = safeLower(state.search.trim());

  return state.conversations.filter((conversation) => {
    const sender = getSender(conversation);
    const assignee = getAssignee(conversation);
    const team = getTeam(conversation);
    const labels = getLabels(conversation);

    if (state.filters.assignee && String(assignee?.id || "") !== state.filters.assignee) {
      return false;
    }
    if (state.filters.team && String(team?.id || "") !== state.filters.team) {
      return false;
    }
    if (state.filters.inbox && String(conversation.inbox_id || "") !== state.filters.inbox) {
      return false;
    }
    if (state.filters.label && !labels.includes(state.filters.label)) {
      return false;
    }
    if (
      state.filters.priority &&
      String(conversation.priority || "none") !== state.filters.priority
    ) {
      return false;
    }
    if (
      state.filters.taskStatus &&
      getTaskStatus(conversation) !== state.filters.taskStatus
    ) {
      return false;
    }

    if (!search) return true;

    const searchable = [
      sender.name,
      sender.phone_number,
      sender.email,
      conversation.id,
      getLastMessage(conversation),
      assignee?.name,
      team?.name,
      ...labels,
    ]
      .map(safeLower)
      .join(" ");

    return searchable.includes(search);
  });
}

function renderAll() {
  renderDashboard();
  renderInterventions();
  renderPipeline();
  renderConversationsTable();
  renderTasks();
  renderContacts();
  updateInterventionNavigation();
}

function renderDashboard() {
  const conversations = filteredConversations();
  const openOpportunities = conversations.filter(
    (conversation) => !["won", "lost"].includes(getConversationStage(conversation))
  );
  const won = conversations.filter((conversation) => getConversationStage(conversation) === "won");
  const pendingTasks = conversations.filter((conversation) => {
    const attributes = getCustomAttributes(conversation);
    return attributes.crm_next_task && !isTrue(attributes.crm_task_done);
  });
  const overdueTasks = pendingTasks.filter((conversation) => {
    const attributes = getCustomAttributes(conversation);
    return isOverdue(attributes.crm_task_due_at, false);
  });
  const pipelineValue = openOpportunities.reduce(
    (sum, conversation) => sum + parseCurrency(getCustomAttributes(conversation).crm_value),
    0
  );
  const wonValue = won.reduce(
    (sum, conversation) => sum + parseCurrency(getCustomAttributes(conversation).crm_value),
    0
  );

  const metrics = [
    {
      label: "Oportunidades abertas",
      value: openOpportunities.length,
      help: `${conversations.length} no seu escopo · ${state.organizationConversationCount} na organização`,
    },
    {
      label: "Valor em pipeline",
      value: formatCurrency(pipelineValue),
      help: "Soma das oportunidades não concluídas",
    },
    {
      label: "Vendas ganhas",
      value: won.length,
      help: `${formatCurrency(wonValue)} em valor registrado`,
    },
    {
      label: "Tarefas vencidas",
      value: overdueTasks.length,
      help: `${pendingTasks.length} tarefas pendentes`,
    },
    {
      label: "Intervenções humanas",
      value: conversations.filter(isIntervention).length,
      help: "Falhas ou atendimentos manuais no seu escopo",
    },
  ];

  elements.metricsGrid.replaceChildren();
  for (const metric of metrics) {
    const card = createElement("article", "metric-card");
    card.append(
      createElement("span", "metric-label", metric.label),
      createElement("strong", "metric-value", metric.value),
      createElement("span", "metric-help", metric.help)
    );
    elements.metricsGrid.appendChild(card);
  }

  renderStageOverview(conversations);
  renderDashboardTasks(pendingTasks);
  renderRecentConversations(conversations);
}

function renderStageOverview(conversations) {
  elements.stageOverview.replaceChildren();
  const maximum = Math.max(
    1,
    ...getOperationalPipelineStages().map(
      (stage) => conversations.filter((conversation) => getConversationStage(conversation) === stage.id).length
    )
  );

  for (const stage of getOperationalPipelineStages()) {
    const stageConversations = sortOperationalQueue(
      conversations.filter((conversation) => getConversationStage(conversation) === stage.id)
    );
    const value = stageConversations.reduce(
      (sum, conversation) => sum + parseCurrency(getCustomAttributes(conversation).crm_value),
      0
    );
    const row = createElement("div", "stage-row");
    const label = createElement("strong", null, `${stage.label} · ${stageConversations.length}`);
    const track = createElement("div", "stage-track");
    const fill = createElement("div", "stage-fill");
    fill.style.width = `${Math.max(2, (stageConversations.length / maximum) * 100)}%`;
    fill.style.background = stage.color;
    track.appendChild(fill);
    row.append(label, track, createElement("span", null, formatCurrency(value)));
    elements.stageOverview.appendChild(row);
  }
}

function renderDashboardTasks() {
  elements.dashboardTasks.replaceChildren();
  const queue = sortOperationalQueue(state.conversations).slice(0, 8);

  if (!queue.length) {
    elements.dashboardTasks.appendChild(
      createElement("div", "empty-state", "Nenhuma obrigação pendente no seu escopo.")
    );
    return;
  }

  for (const conversation of queue) {
    const sender = getSender(conversation);
    const attributes = getCustomAttributes(conversation);
    const item = createElement(
      "div",
      `compact-item focus-item ${isIntervention(conversation) ? "is-intervention" : ""}`
    );
    const button = createElement("button");
    button.type = "button";
    button.append(
      createElement("strong", null, focusReason(conversation)),
      createElement("span", null, sender.name || `Conversa #${conversation.id}`)
    );
    button.addEventListener("click", () => openOpportunityDrawer(conversation.id));
    const detail = createElement(
      "span",
      "focus-item-detail",
      attributes.crm_next_task ||
        `${formatRelativeTime(conversationActivityTimestamp(conversation))} sem interação`
    );
    item.append(button, detail);
    elements.dashboardTasks.appendChild(item);
  }
}

function renderRecentConversations(conversations) {
  elements.recentConversations.replaceChildren();
  if (!conversations.length) {
    elements.recentConversations.appendChild(createElement("div", "empty-state", "Nenhuma conversa encontrada."));
    return;
  }

  for (const conversation of conversations.slice(0, 8)) {
    const sender = getSender(conversation);
    const item = createElement("div", "data-row");
    const button = createElement("button");
    button.type = "button";
    button.append(
      createElement("strong", null, sender.name || `Contato #${conversation.id}`),
      createElement("span", null, getLastMessage(conversation))
    );
    button.addEventListener("click", () => openOpportunityDrawer(conversation.id));
    item.append(
      button,
      createElement("span", null, formatRelativeTime(conversationActivityTimestamp(conversation)))
    );
    elements.recentConversations.appendChild(item);
  }
}

function updateInterventionNavigation() {
  const count = state.conversations.filter(isIntervention).length;
  state.interventionCount = count;
  if (elements.interventionNavCount) {
    elements.interventionNavCount.textContent = String(count);
    elements.interventionNavCount.classList.toggle("is-hidden", count === 0);
  }
  if (elements.interventionViewCount) {
    elements.interventionViewCount.textContent = String(count);
  }
}

function renderInterventions() {
  if (!elements.interventionList) return;
  const linkedAgentId = Number(state.user?.chatwootAgentId || 0);
  let conversations = state.conversations.filter(isIntervention);
  if (state.interventionFilter === "unassigned") {
    conversations = conversations.filter((conversation) => !getAssigneeId(conversation));
  } else if (state.interventionFilter === "mine") {
    conversations = conversations.filter(
      (conversation) => linkedAgentId > 0 && getAssigneeId(conversation) === linkedAgentId
    );
  }
  conversations = sortOperationalQueue(conversations);
  elements.interventionList.replaceChildren();

  if (!conversations.length) {
    elements.interventionList.appendChild(
      createElement("div", "empty-state intervention-empty", "Nenhuma intervenção pendente neste filtro.")
    );
    updateInterventionNavigation();
    return;
  }

  for (const conversation of conversations) {
    const sender = getSender(conversation);
    const assignee = getAssignee(conversation);
    const item = createElement("article", "intervention-card");
    const header = createElement("div", "intervention-card-header");
    const info = createElement("div");
    info.append(
      createElement("span", "intervention-kicker", "⚠ INTERVENÇÃO HUMANA"),
      createElement("strong", null, sender.name || `Conversa #${conversation.id}`),
      createElement("small", null, `#${conversation.id} · ${getStage(getConversationStage(conversation)).label}`)
    );
    const age = createElement(
      "span",
      "intervention-age",
      `${formatRelativeTime(conversationActivityTimestamp(conversation))} sem interação`
    );
    header.append(info, age);

    const details = createElement("div", "intervention-card-details");
    details.append(
      createElement(
        "span",
        null,
        interventionLabels(conversation).map((label) => getLabelTitle(label)).join(" · ")
      ),
      createElement("span", null, assignee?.name ? `Responsável: ${assignee.name}` : "Sem responsável")
    );

    const actions = createElement("div", "intervention-actions");
    const open = createElement("button", "button button-ghost button-small", "Abrir");
    open.type = "button";
    open.addEventListener("click", () => openOpportunityDrawer(conversation.id));
    actions.appendChild(open);

    if (hasPermission("interventions:manage")) {
      const assume = createElement("button", "button button-primary button-small", "Assumir");
      assume.type = "button";
      assume.disabled = !state.user?.chatwootAgentId;
      assume.title = assume.disabled ? "Vincule seu usuário a um agente do Chatwoot" : "";
      assume.addEventListener("click", () => assumeIntervention(conversation.id));
      const resolve = createElement("button", "button button-ghost button-small", "Resolver e liberar");
      resolve.type = "button";
      resolve.addEventListener("click", () => resolveIntervention(conversation.id));
      actions.append(assume, resolve);
    }

    item.append(header, details, actions);
    elements.interventionList.appendChild(item);
  }
  updateInterventionNavigation();
}

async function assumeIntervention(conversationId) {
  if (!hasPermission("interventions:manage")) return;
  try {
    await apiRequest(`/api/crm/interventions/${conversationId}/assume`, { method: "POST" });
    showToast("Intervenção assumida. A automação permanece bloqueada.", "success");
    await loadWorkspace({ background: true });
    if (state.currentConversationId === Number(conversationId)) {
      await openOpportunityDrawer(conversationId);
    }
  } catch (error) {
    showToast(`Não foi possível assumir: ${error.message}`, "error");
  }
}

async function resolveIntervention(conversationId) {
  if (!hasPermission("interventions:manage")) return;
  const confirmed = window.confirm(
    "Remover as etiquetas de intervenção e liberar este lead para o fluxo automático?"
  );
  if (!confirmed) return;
  try {
    await apiRequest(`/api/crm/interventions/${conversationId}/resolve`, { method: "POST" });
    showToast("Intervenção resolvida e etiquetas de bloqueio removidas.", "success");
    await loadWorkspace({ background: true });
    if (state.currentConversationId === Number(conversationId)) closeOpportunityDrawer();
  } catch (error) {
    showToast(`Não foi possível resolver: ${error.message}`, "error");
  }
}

function renderPipeline() {
  const conversations = filteredConversations();
  elements.pipelineBoard.replaceChildren();
  elements.pipelineResultCount.textContent = `${conversations.length} ${
    conversations.length === 1 ? "oportunidade exibida" : "oportunidades exibidas"
  }`;

  const roleStages = getOperationalPipelineStages();
  const allowedStageIds = new Set(roleStages.map((stage) => stage.id));
  const pendingAlignment = sortOperationalQueue(
    conversations.filter((conversation) => !allowedStageIds.has(getConversationStage(conversation)))
  );
  const columns = pendingAlignment.length
    ? [
        {
          id: "__pending_alignment",
          label: "Pendente de enquadramento",
          color: "#dc2626",
          virtual: true,
          conversations: pendingAlignment,
        },
        ...roleStages.map((stage) => ({
          ...stage,
          conversations: sortOperationalQueue(
            conversations.filter((conversation) => getConversationStage(conversation) === stage.id)
          ),
        })),
      ]
    : roleStages.map((stage) => ({
        ...stage,
        conversations: sortOperationalQueue(
          conversations.filter((conversation) => getConversationStage(conversation) === stage.id)
        ),
      }));

  for (const stage of columns) {
    const stageConversations = stage.conversations;
    const stageValue = stageConversations.reduce(
      (sum, conversation) => sum + parseCurrency(getCustomAttributes(conversation).crm_value),
      0
    );

    const column = createElement(
      "section",
      `pipeline-column${stage.virtual ? " pipeline-column-warning" : ""}`
    );
    column.dataset.stage = stage.id;
    const header = createElement("header", "pipeline-column-header");
    const title = createElement("div", "pipeline-title");
    const dot = createElement("span", "stage-dot");
    dot.style.background = stage.color;
    title.append(dot, createElement("strong", null, stage.label));
    const headerMeta = createElement(
      "span",
      "pipeline-column-meta",
      `${stageConversations.length} · ${formatCurrency(stageValue)}`
    );
    header.append(title, headerMeta);

    const list = createElement("div", "pipeline-list");
    list.dataset.stage = stage.id;
    for (const conversation of stageConversations) {
      list.appendChild(createOpportunityCard(conversation));
    }
    if (!stageConversations.length) {
      list.appendChild(createElement("div", "pipeline-empty", "Nenhuma oportunidade nesta etapa"));
    }

    if (hasPermission("opportunities:write") && !stage.virtual) {
      column.addEventListener("dragover", (event) => {
        event.preventDefault();
        column.classList.add("is-drag-over");
      });
      column.addEventListener("dragleave", () => column.classList.remove("is-drag-over"));
      column.addEventListener("drop", async (event) => {
        event.preventDefault();
        column.classList.remove("is-drag-over");
        const conversationId = Number(state.draggingConversationId);
        if (!conversationId) return;
        await requestStageTransition(conversationId, stage.id);
      });
    }

    column.append(header, list);
    elements.pipelineBoard.appendChild(column);
  }
}

function createOpportunityCard(conversation) {
  const sender = getSender(conversation);
  const attributes = getCustomAttributes(conversation);
  const assignee = getAssignee(conversation);
  const team = getTeam(conversation);
  const inbox = getInbox(conversation);
  const labels = getLabels(conversation);
  const taskStatus = getTaskStatus(conversation);
  const card = createElement(
    "article",
    `opportunity-card ${idleClass(conversation)}${isIntervention(conversation) ? " is-intervention" : ""}`
  );
  card.draggable = hasPermission("opportunities:write");
  card.dataset.id = String(conversation.id);
  card.title = `Conversa #${conversation.id} · ${formatDate(
    conversationActivityTimestamp(conversation)
  )}`;

  const top = createElement("div", "card-top");
  top.append(
    createElement("strong", null, sender.name || `Contato #${conversation.id}`),
    createElement("span", "card-meta", `#${conversation.id}`)
  );
  card.appendChild(top);
  card.appendChild(createElement("div", "card-phone", sender.phone_number || sender.email || "Sem contato"));
  card.appendChild(createElement("div", "card-message", getLastMessage(conversation)));

  if (isIntervention(conversation)) {
    const warning = createElement("div", "card-intervention-warning");
    warning.append(
      createElement("strong", null, "⚠ Intervenção humana"),
      createElement(
        "span",
        null,
        interventionLabels(conversation).some((label) => safeLower(label) === "atendimento-manual")
          ? "Atendimento manual em andamento"
          : "Fluxo aguardando ação humana"
      )
    );
    card.appendChild(warning);
  }

  const badges = createElement("div", "card-badges");
  if (conversation.priority && conversation.priority !== "none") {
    badges.appendChild(
      createElement("span", `badge ${conversation.priority}`, priorityLabel(conversation.priority))
    );
  }
  if (Number(conversation.unread_count || 0) > 0) {
    badges.appendChild(createElement("span", "badge unread", `${conversation.unread_count} não lida(s)`));
  }
  for (const label of labels.slice(0, 3)) {
    badges.appendChild(createLabelChip(label, { compact: true }));
  }
  if (labels.length > 3) {
    badges.appendChild(createElement("span", "badge badge-more", `+${labels.length - 3}`));
  }
  card.appendChild(badges);

  const context = createElement("div", "card-context");
  const contextItems = [
    assignee?.name ? `👤 ${assignee.name}` : "👤 Sem responsável",
    team?.name ? `👥 ${team.name}` : null,
    inbox?.name ? `▣ ${inbox.name}` : null,
  ].filter(Boolean);
  for (const item of contextItems) {
    context.appendChild(createElement("span", null, item));
  }
  card.appendChild(context);

  const footer = createElement("div", "card-footer");
  const value = parseCurrency(attributes.crm_value);
  footer.append(
    createElement("span", "card-value", value ? formatCurrency(value) : "Sem valor"),
    createElement(
      "span",
      `card-meta activity-age ${idleClass(conversation)}`,
      `${formatRelativeTime(conversationActivityTimestamp(conversation))} sem interação`
    )
  );
  card.appendChild(footer);

  if (taskStatus !== "none") {
    const taskHeader = createElement("div", "card-task-header");
    taskHeader.append(
      createElement("span", `task-status task-status-${taskStatus}`, taskStatusLabel(taskStatus)),
      attributes.crm_task_due_at
        ? createElement(
            "span",
            `task-due ${taskStatus === "overdue" ? "overdue" : ""}`,
            formatDate(attributes.crm_task_due_at, { dateOnly: true })
          )
        : createElement("span", "task-due", "Sem prazo")
    );
    const task = createElement(
      "div",
      "card-task",
      attributes.crm_next_task
    );
    card.append(taskHeader, task);
  }

  const quickActions = createElement("div", "card-quick-actions");
  const quickDefinitions = [
    ["task", "✓", "Criar ou editar tarefa"],
    ["assignee", "👤", "Alterar responsável"],
    ["won", "★", "Marcar como ganho"],
    ["lost", "×", "Marcar como perdido"],
    ["chatwoot", "↗", "Abrir no Chatwoot"],
  ];
  for (const [action, icon, titleText] of quickDefinitions) {
    const button = createElement("button", `card-quick-action action-${action}`, icon);
    button.type = "button";
    button.draggable = false;
    button.title = titleText;
    button.dataset.quickAction = action;
    if (action !== "chatwoot" && !hasPermission("opportunities:write")) button.disabled = true;
    button.addEventListener("mousedown", (event) => event.stopPropagation());
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (action === "task") return openOpportunityDrawer(conversation.id, { focus: "task" });
      if (action === "assignee") return openOpportunityDrawer(conversation.id, { focus: "assignee" });
      if (action === "won" || action === "lost") {
        return requestStageTransition(conversation.id, action);
      }
      if (action === "chatwoot") return openInChatwootById(conversation.id);
    });
    quickActions.appendChild(button);
  }
  if (isIntervention(conversation) && hasPermission("interventions:manage")) {
    const assume = createElement("button", "card-intervention-action", "Assumir");
    assume.type = "button";
    assume.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await assumeIntervention(conversation.id);
    });
    quickActions.prepend(assume);
  }
  card.appendChild(quickActions);

  card.addEventListener("dragstart", () => {
    state.draggingConversationId = conversation.id;
    card.classList.add("is-dragging");
  });
  card.addEventListener("dragend", () => {
    state.draggingConversationId = null;
    card.classList.remove("is-dragging");
  });
  card.addEventListener("click", () => openOpportunityDrawer(conversation.id));
  return card;
}

async function requestStageTransition(conversationId, stageId) {
  if (!hasPermission("opportunities:write")) {
    showToast("Seu perfil possui acesso somente para leitura.", "error");
    return;
  }
  const conversation = state.conversations.find((item) => Number(item.id) === Number(conversationId));
  if (!conversation || getConversationStage(conversation) === stageId) return;

  if (["won", "lost"].includes(stageId)) {
    openTransitionModal(conversationId, stageId);
    return;
  }
  await moveOpportunity(conversationId, stageId, {});
}

function openTransitionModal(conversationId, stageId) {
  const conversation = state.conversations.find((item) => Number(item.id) === Number(conversationId));
  if (!conversation) return;
  const sender = getSender(conversation);
  const attributes = getCustomAttributes(conversation);
  state.pendingTransition = { conversationId, stageId };
  elements.transitionModalTitle.textContent = stageId === "won" ? "Marcar oportunidade como ganha" : "Marcar oportunidade como perdida";
  elements.transitionModalDescription.textContent = `${sender.name || `Conversa #${conversation.id}`} · #${conversation.id}`;
  elements.transitionValueField.classList.toggle("is-hidden", stageId !== "won");
  elements.transitionReasonField.classList.toggle("is-hidden", stageId !== "lost");
  elements.transitionValue.value = parseCurrency(attributes.crm_value) || "";
  elements.transitionReason.value = attributes.crm_loss_reason || "";
  elements.transitionModal.classList.add("is-open");
  elements.transitionModal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  window.setTimeout(() => {
    (stageId === "won" ? elements.transitionValue : elements.transitionReason).focus();
  }, 60);
}

function closeTransitionModal() {
  elements.transitionModal.classList.remove("is-open");
  elements.transitionModal.setAttribute("aria-hidden", "true");
  state.pendingTransition = null;
  if (!elements.drawer.classList.contains("is-open")) document.body.style.overflow = "";
}

async function confirmTransition(event) {
  event.preventDefault();
  const transition = state.pendingTransition;
  if (!transition) return;
  const extras = {};
  if (transition.stageId === "won") {
    const value = Number(elements.transitionValue.value);
    if (!Number.isFinite(value) || value <= 0) {
      showToast("Informe um valor maior que zero para concluir a venda.", "error");
      elements.transitionValue.focus();
      return;
    }
    extras.crm_value = value;
    extras.crm_loss_reason = "";
  } else {
    const reason = elements.transitionReason.value.trim();
    if (!reason) {
      showToast("Informe o motivo da perda.", "error");
      elements.transitionReason.focus();
      return;
    }
    extras.crm_loss_reason = reason;
  }
  elements.transitionConfirm.disabled = true;
  try {
    const moved = await moveOpportunity(transition.conversationId, transition.stageId, extras);
    if (moved) closeTransitionModal();
  } finally {
    elements.transitionConfirm.disabled = false;
  }
}

async function moveOpportunity(conversationId, stageId, extras = {}) {
  const conversation = state.conversations.find((item) => Number(item.id) === Number(conversationId));
  if (!conversation || getConversationStage(conversation) === stageId) return false;

  const previousAttributes = { ...getCustomAttributes(conversation) };
  const nextAttributes = { ...previousAttributes, ...extras, crm_stage: stageId };
  conversation.custom_attributes = nextAttributes;
  renderAll();

  try {
    await updateCustomAttributes(conversationId, nextAttributes);
    showToast(`Oportunidade movida para ${getStage(stageId).label}.`, "success");
    return true;
  } catch (error) {
    conversation.custom_attributes = previousAttributes;
    renderAll();
    showToast(`Não foi possível mover a oportunidade: ${error.message}`, "error");
    return false;
  }
}

function renderConversationsTable() {
  const conversations = filteredConversations();
  elements.conversationCount.textContent = String(conversations.length);
  elements.conversationsTable.replaceChildren();

  if (!conversations.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.className = "empty-state";
    cell.textContent = "Nenhuma conversa encontrada.";
    row.appendChild(cell);
    elements.conversationsTable.appendChild(row);
    return;
  }

  for (const conversation of conversations) {
    const sender = getSender(conversation);
    const assignee = getAssignee(conversation);
    const row = document.createElement("tr");

    const contactCell = createElement("td", "table-contact");
    contactCell.append(
      createElement("strong", null, sender.name || `Contato #${conversation.id}`),
      createElement("span", null, sender.phone_number || sender.email || "—")
    );

    const actionCell = document.createElement("td");
    const action = createElement("button", "row-action", "Abrir");
    action.type = "button";
    action.addEventListener("click", () => openOpportunityDrawer(conversation.id));
    actionCell.appendChild(action);

    row.append(
      contactCell,
      createElement("td", null, getStage(getConversationStage(conversation)).label),
      createElement("td", null, statusLabel(conversation.status)),
      createElement("td", null, assignee?.name || "Não atribuído"),
      createElement("td", null, formatDate(conversationActivityTimestamp(conversation))),
      actionCell
    );
    elements.conversationsTable.appendChild(row);
  }
}

function renderTasks() {
  const allTasks = filteredConversations()
    .filter((conversation) => getCustomAttributes(conversation).crm_next_task)
    .sort((a, b) => {
      const aStatus = getTaskStatus(a);
      const bStatus = getTaskStatus(b);
      const rank = { overdue: 0, pending: 1, done: 2, none: 3 };
      if (rank[aStatus] !== rank[bStatus]) return rank[aStatus] - rank[bStatus];
      const aDate = getCustomAttributes(a).crm_task_due_at || "9999-12-31";
      const bDate = getCustomAttributes(b).crm_task_due_at || "9999-12-31";
      return aDate.localeCompare(bDate);
    });

  const counts = {
    all: allTasks.length,
    pending: allTasks.filter((conversation) => getTaskStatus(conversation) === "pending").length,
    overdue: allTasks.filter((conversation) => getTaskStatus(conversation) === "overdue").length,
    done: allTasks.filter((conversation) => getTaskStatus(conversation) === "done").length,
  };

  const tasks =
    state.taskViewFilter === "all"
      ? allTasks
      : allTasks.filter((conversation) => getTaskStatus(conversation) === state.taskViewFilter);

  elements.taskCount.textContent = String(allTasks.length);
  elements.taskSummary.replaceChildren();
  for (const [key, label] of [
    ["pending", "Pendentes"],
    ["overdue", "Vencidas"],
    ["done", "Concluídas"],
  ]) {
    const summary = createElement("div", `task-summary-card ${key}`);
    summary.append(createElement("strong", null, counts[key]), createElement("span", null, label));
    elements.taskSummary.appendChild(summary);
  }

  document.querySelectorAll("[data-task-view-filter]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.taskViewFilter === state.taskViewFilter);
    const key = button.dataset.taskViewFilter;
    if (counts[key] !== undefined) {
      button.textContent = `${button.textContent.replace(/\s+\(\d+\)$/, "")} (${counts[key]})`;
    } else if (key === "all") {
      button.textContent = `Todas (${counts.all})`;
    }
  });
  elements.tasksList.replaceChildren();

  if (!tasks.length) {
    elements.tasksList.appendChild(createElement("div", "empty-state", "Nenhuma tarefa registrada."));
    return;
  }

  for (const conversation of tasks) {
    const sender = getSender(conversation);
    const attributes = getCustomAttributes(conversation);
    const status = getTaskStatus(conversation);
    const done = status === "done";
    const item = createElement("div", `task-item task-${status} ${done ? "is-complete" : ""}`);
    const button = createElement("button");
    button.type = "button";
    button.append(
      createElement("strong", null, `${done ? "✓ " : ""}${attributes.crm_next_task}`),
      createElement(
        "span",
        null,
        `${sender.name || `Conversa #${conversation.id}`} · #${conversation.id} · ${getStage(
          getConversationStage(conversation)
        ).label}`
      )
    );
    button.addEventListener("click", () => openOpportunityDrawer(conversation.id));
    const actions = createElement("div", "task-actions");
    const statusChip = createElement(
      "span",
      `task-status task-status-${status}`,
      taskStatusLabel(status)
    );
    const dueText = done && attributes.crm_task_completed_at
      ? `Concluída em ${formatDate(attributes.crm_task_completed_at)}`
      : attributes.crm_task_due_at
        ? formatDate(attributes.crm_task_due_at, { dateOnly: true })
        : "Sem prazo";
    const due = createElement(
      "span",
      `task-due ${status === "overdue" ? "overdue" : ""}`,
      dueText
    );
    const toggle = createElement(
      "button",
      `task-toggle ${done ? "is-done" : ""}`,
      done ? "Reabrir" : "Concluir"
    );
    toggle.type = "button";
    toggle.disabled = !hasPermission("opportunities:write");
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleTaskCompletion(conversation.id, !done);
    });
    actions.append(statusChip, due, toggle);
    item.append(button, actions);
    elements.tasksList.appendChild(item);
  }
}

async function toggleTaskCompletion(conversationId, done) {
  const conversation = state.conversations.find(
    (item) => Number(item.id) === Number(conversationId)
  );
  if (!conversation) return;

  const previous = getCustomAttributes(conversation);
  const next = {
    ...previous,
    crm_task_done: done,
    crm_task_completed_at: done ? new Date().toISOString() : null,
  };
  conversation.custom_attributes = next;
  renderAll();

  try {
    await updateCustomAttributes(conversationId, next);
    showToast(done ? "Tarefa concluída." : "Tarefa reaberta.", "success");
  } catch (error) {
    conversation.custom_attributes = previous;
    renderAll();
    showToast(`Não foi possível atualizar a tarefa: ${error.message}`, "error");
  }
}

function renderContacts() {
  const contactMap = new Map();
  for (const conversation of filteredConversations()) {
    const sender = getSender(conversation);
    const key = sender.id || sender.identifier || sender.phone_number || sender.email || `conversation-${conversation.id}`;
    const existing = contactMap.get(key) || {
      sender,
      count: 0,
      lastActivity: 0,
    };
    existing.count += 1;
    existing.lastActivity = Math.max(existing.lastActivity, conversationActivityTimestamp(conversation));
    contactMap.set(key, existing);
  }

  const contacts = [...contactMap.values()].sort((a, b) => b.lastActivity - a.lastActivity);
  elements.contactCount.textContent = String(contacts.length);
  elements.contactsTable.replaceChildren();

  if (!contacts.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.className = "empty-state";
    cell.textContent = "Nenhum contato encontrado.";
    row.appendChild(cell);
    elements.contactsTable.appendChild(row);
    return;
  }

  for (const contact of contacts) {
    const row = document.createElement("tr");
    row.append(
      createElement("td", null, contact.sender.name || "Sem nome"),
      createElement("td", null, contact.sender.phone_number || "—"),
      createElement("td", null, contact.sender.email || "—"),
      createElement("td", null, contact.count),
      createElement("td", null, formatDate(contact.lastActivity))
    );
    elements.contactsTable.appendChild(row);
  }
}

function populateFilterOptions() {
  fillSelect(elements.filterAssignee, state.agents, "Todos os responsáveis");
  fillSelect(elements.filterTeam, state.teams, "Todos os times");
  fillSelect(elements.filterInbox, state.inboxes, "Todas as caixas");

  const labelOptions = state.labels
    .map((label) => ({
      id: getLabelTitle(label),
      name: getLabelTitle(label),
    }))
    .filter((label) => label.id);
  fillSelect(elements.filterLabel, labelOptions, "Todas as etiquetas");
}

function populateDrawerOptions() {
  elements.drawerStage.replaceChildren();
  for (const stage of getVisiblePipelineStages()) {
    const option = document.createElement("option");
    option.value = stage.id;
    option.textContent = stage.label;
    elements.drawerStage.appendChild(option);
  }

  fillSelect(elements.drawerAssignee, state.agents, "Não atribuído");
  fillSelect(elements.drawerTeam, state.teams, "Sem time");
}

function fillSelect(select, items, placeholder) {
  const currentValue = select.value;
  select.replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = placeholder;
  select.appendChild(empty);

  for (const item of items) {
    const option = document.createElement("option");
    option.value = String(item.id ?? item.name);
    option.textContent = item.name || item.available_name || String(item.id);
    select.appendChild(option);
  }

  if ([...select.options].some((option) => option.value === currentValue)) {
    select.value = currentValue;
  }
}

function drawerConversation() {
  return state.conversations.find(
    (conversation) => Number(conversation.id) === Number(state.currentConversationId)
  );
}

function allDrawerLabelDefinitions(conversation) {
  const definitions = new Map();
  for (const definition of state.labels) {
    const title = getLabelTitle(definition);
    if (title) definitions.set(safeLower(title), definition);
  }
  for (const title of getLabels(conversation)) {
    const key = safeLower(title);
    if (!definitions.has(key)) {
      definitions.set(key, { title, description: "Etiqueta presente na conversa", color: "#64748B" });
    }
  }
  return [...definitions.values()].sort((a, b) =>
    getLabelTitle(a).localeCompare(getLabelTitle(b), "pt-BR", { sensitivity: "base" })
  );
}

function renderDrawerLabelOptions() {
  const conversation = drawerConversation();
  if (!conversation || !elements.drawerLabelOptions) return;
  const query = safeLower(elements.drawerLabelSearch?.value || "");
  const canWrite = hasPermission("opportunities:write");
  const definitions = allDrawerLabelDefinitions(conversation).filter((definition) => {
    const searchable = `${getLabelTitle(definition)} ${definition.description || ""}`;
    return !query || safeLower(searchable).includes(query);
  });

  elements.drawerLabelOptions.replaceChildren();
  if (!definitions.length) {
    elements.drawerLabelOptions.appendChild(
      createElement("div", "empty-state label-empty-state", "Nenhuma etiqueta encontrada.")
    );
    return;
  }

  for (const definition of definitions) {
    const title = getLabelTitle(definition);
    const row = createElement("label", "label-option");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.labelDraft.has(title);
    checkbox.disabled = !canWrite;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.labelDraft.add(title);
      else state.labelDraft.delete(title);
    });
    const info = createElement("span", "label-option-info");
    info.appendChild(createLabelChip(title));
    if (definition.description) {
      info.appendChild(createElement("small", null, definition.description));
    }
    row.append(checkbox, info);
    elements.drawerLabelOptions.appendChild(row);
  }
}

function renderDrawerLabels(conversation = drawerConversation()) {
  if (!conversation) return;
  const labels = getLabels(conversation);
  elements.drawerLabels.replaceChildren();
  if (!labels.length) {
    elements.drawerLabels.appendChild(
      createElement("span", "muted label-empty-text", "Nenhuma etiqueta atribuída.")
    );
  } else {
    for (const label of labels) elements.drawerLabels.appendChild(createLabelChip(label));
  }
  renderDrawerLabelOptions();
}

function toggleDrawerLabelEditor(forceOpen) {
  const shouldOpen = typeof forceOpen === "boolean"
    ? forceOpen
    : elements.drawerLabelEditor.classList.contains("is-hidden");
  elements.drawerLabelEditor.classList.toggle("is-hidden", !shouldOpen);
  elements.toggleLabelEditor.textContent = shouldOpen
    ? "Fechar editor"
    : hasPermission("opportunities:write")
      ? "Editar etiquetas"
      : "Visualizar etiquetas";
  if (shouldOpen) {
    renderDrawerLabelOptions();
    elements.drawerLabelSearch.focus();
  }
}

function cancelDrawerLabelChanges() {
  const conversation = drawerConversation();
  if (!conversation) return;
  state.labelDraft = new Set(getLabels(conversation));
  elements.drawerLabelSearch.value = "";
  renderDrawerLabelOptions();
  toggleDrawerLabelEditor(false);
}

async function saveDrawerLabels() {
  if (!hasPermission("opportunities:write")) {
    showToast("Seu perfil possui acesso somente para leitura.", "error");
    return;
  }
  const conversation = drawerConversation();
  if (!conversation) return;

  const currentLabels = getLabels(conversation);
  const selectedLabels = [...state.labelDraft];
  const currentKeys = new Map(currentLabels.map((label) => [safeLower(label), label]));
  const selectedKeys = new Map(selectedLabels.map((label) => [safeLower(label), label]));
  const add = [...selectedKeys.entries()]
    .filter(([key]) => !currentKeys.has(key))
    .map(([, label]) => label);
  const remove = [...currentKeys.entries()]
    .filter(([key]) => !selectedKeys.has(key))
    .map(([, label]) => label);

  if (!add.length && !remove.length) {
    showToast("Nenhuma alteração nas etiquetas.", "success");
    toggleDrawerLabelEditor(false);
    return;
  }

  elements.saveLabels.disabled = true;
  try {
    const result = await apiRequest(`/api/crm/opportunities/${conversation.id}/labels`, {
      method: "POST",
      body: JSON.stringify({ add, remove }),
    });
    const labels = Array.isArray(result?.labels) ? result.labels : selectedLabels;
    conversation.labels = labels;
    conversation.label_list = labels;
    state.labelDraft = new Set(labels);
    elements.drawerLabelSearch.value = "";
    renderDrawerLabels(conversation);
    renderAll();
    toggleDrawerLabelEditor(false);
    showToast("Etiquetas atualizadas no Chatwoot.", "success");
  } catch (error) {
    showToast(`Não foi possível atualizar as etiquetas: ${error.message}`, "error");
  } finally {
    elements.saveLabels.disabled = !hasPermission("opportunities:write");
  }
}

async function openOpportunityDrawer(conversationId, options = {}) {
  const conversation = state.conversations.find((item) => Number(item.id) === Number(conversationId));
  if (!conversation) return;

  state.currentConversationId = Number(conversationId);
  state.showSystemEvents = false;
  state.currentMessages = [];
  const sender = getSender(conversation);
  const attributes = getCustomAttributes(conversation);
  const assignee = getAssignee(conversation);
  const team = getTeam(conversation);

  elements.drawerConversationId.textContent = `CONVERSA #${conversation.id}`;
  elements.drawerContactName.textContent = sender.name || `Contato #${conversation.id}`;
  elements.drawerContactMeta.textContent = [sender.phone_number, sender.email]
    .filter(Boolean)
    .join(" · ") || "Sem telefone ou e-mail";
  elements.drawerStage.value = getConversationStage(conversation);
  elements.drawerValue.value = parseCurrency(attributes.crm_value) || "";
  elements.drawerPriority.value = conversation.priority || "none";
  elements.drawerAssignee.value = assignee?.id ? String(assignee.id) : "";
  elements.drawerTeam.value = team?.id ? String(team.id) : "";
  elements.drawerTask.value = attributes.crm_next_task || "";
  elements.drawerDueDate.value = attributes.crm_task_due_at || "";
  elements.drawerTaskDone.checked = isTrue(attributes.crm_task_done);
  elements.drawerTaskCompletedAt.dataset.value = attributes.crm_task_completed_at || "";
  elements.drawerLossReason.value = attributes.crm_loss_reason || "";
  const canWrite = hasPermission("opportunities:write");
  const canAssign = hasPermission("assignments:manage");
  elements.drawerInterventionPanel.classList.toggle("is-hidden", !isIntervention(conversation));
  if (isIntervention(conversation)) {
    const labels = interventionLabels(conversation);
    elements.drawerInterventionTitle.textContent = labels.some(
      (label) => safeLower(label) === "atendimento-manual"
    )
      ? "Atendimento manual em andamento"
      : "Ação humana necessária";
    elements.drawerInterventionDescription.textContent = labels.join(" · ");
    elements.assumeIntervention.disabled = !hasPermission("interventions:manage") || !state.user?.chatwootAgentId;
    elements.resolveIntervention.disabled = !hasPermission("interventions:manage");
  }
  [
    elements.drawerStage,
    elements.drawerValue,
    elements.drawerPriority,
    elements.drawerAssignee,
    elements.drawerTeam,
    elements.drawerTask,
    elements.drawerDueDate,
    elements.drawerTaskDone,
    elements.drawerLossReason,
  ].forEach((element) => {
    element.disabled = !canWrite;
  });
  elements.drawerAssignee.disabled = !canAssign;
  elements.drawerTeam.disabled = !canAssign;
  elements.saveOpportunity.disabled = !canWrite;
  elements.replyContent.disabled = !hasPermission("messages:send");
  elements.replyPrivate.disabled = !hasPermission("messages:send");
  elements.replySubmit.disabled = !hasPermission("messages:send");
  toggleLossReason();
  updateDrawerTaskState();

  state.labelDraft = new Set(getLabels(conversation));
  elements.drawerLabelSearch.value = "";
  elements.drawerLabelEditor.classList.add("is-hidden");
  elements.toggleLabelEditor.textContent = canWrite ? "Editar etiquetas" : "Visualizar etiquetas";
  elements.saveLabels.disabled = !canWrite;
  renderDrawerLabels(conversation);

  elements.drawer.classList.add("is-open");
  elements.drawer.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  await loadMessages();
  if (options.focus === "task") {
    elements.drawerTask.focus();
    elements.drawerTask.scrollIntoView({ behavior: "smooth", block: "center" });
  } else if (options.focus === "assignee") {
    elements.drawerAssignee.focus();
    elements.drawerAssignee.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function closeOpportunityDrawer() {
  elements.drawer.classList.remove("is-open");
  elements.drawer.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  state.currentConversationId = null;
  state.currentMessages = [];
  state.showSystemEvents = false;
}

function toggleLossReason() {
  elements.lossReasonField.classList.toggle("is-hidden", elements.drawerStage.value !== "lost");
}

function updateDrawerTaskState() {
  const task = elements.drawerTask.value.trim();
  const done = elements.drawerTaskDone.checked;
  const due = elements.drawerDueDate.value;
  let status = "none";
  if (task) {
    status = done ? "done" : isOverdue(due, false) ? "overdue" : "pending";
  }
  elements.drawerTaskState.textContent = taskStatusLabel(status);
  elements.drawerTaskState.className = `task-state-value task-state-${status}`;

  const completedAt = elements.drawerTaskCompletedAt.dataset.value;
  elements.drawerTaskCompletedAt.textContent =
    status === "done" && completedAt
      ? `Concluída em ${formatDate(completedAt)}`
      : status === "overdue"
        ? "O prazo informado já venceu."
        : status === "pending" && due
          ? `Prazo: ${formatDate(due, { dateOnly: true })}`
          : "";
}


function messageContent(message) {
  return String(
    message?.content ||
      message?.processed_message_content ||
      attachmentDescription(message) ||
      ""
  ).trim();
}

function isSystemActivityMessage(message) {
  const numericType = Number(message?.message_type);
  const rawType = safeLower(message?.message_type);
  const contentType = safeLower(message?.content_type);
  const senderType = safeLower(message?.sender_type || message?.sender?.type);
  const attributes = message?.content_attributes || {};

  if (numericType === 2 || rawType === "activity" || contentType === "activity") return true;
  if (attributes.event || attributes.event_type || attributes.activity_type) return true;
  if (senderType === "system" || senderType === "activity") return true;

  const content = messageContent(message);
  if (!content) return false;

  return (
    /^(?:conversa\s+)?(?:foi\s+)?(?:marcada\s+como\s+resolvida|reaberta|atribu[ií]d[oa]\s+a)\b/i.test(content) ||
    /\b(?:adicionou|removeu)\s+[a-z0-9][a-z0-9_-]{2,}\s*$/i.test(content) ||
    /\b(?:atribuiu|transferiu)\s+(?:a|para)\b/i.test(content)
  );
}

function classifySystemActivity(content) {
  const text = String(content || "").trim();

  let match = text.match(/^(.*?)\s+(adicionou|removeu)\s+([a-z0-9][a-z0-9_-]{2,})\s*$/i);
  if (match) {
    return {
      type: "label",
      icon: "🏷",
      actor: match[1].trim(),
      action: safeLower(match[2]) === "adicionou" ? "Etiqueta adicionada" : "Etiqueta removida",
      label: match[3].trim(),
    };
  }

  match = text.match(/^Atribu[ií]d[oa]\s+a\s+(.+?)(?:\s+por\s+(.+))?$/i);
  if (match) {
    return {
      type: "assignment",
      icon: "👤",
      action: "Responsável atualizado",
      target: match[1].trim(),
      actor: match[2]?.trim() || "",
    };
  }

  match = text.match(/^(?:Conversa\s+)?foi\s+marcada\s+como\s+resolvida(?:\s+por\s+(.+))?$/i);
  if (match) {
    return {
      type: "resolved",
      icon: "✓",
      action: "Conversa resolvida",
      actor: match[1]?.trim() || "",
    };
  }

  match = text.match(/^(?:Conversa\s+)?foi\s+reaberta(?:\s+por\s+(.+))?$/i);
  if (match) {
    return {
      type: "reopened",
      icon: "↻",
      action: "Conversa reaberta",
      actor: match[1]?.trim() || "",
    };
  }

  return {
    type: "generic",
    icon: "⚙",
    action: "Atividade do sistema",
    detail: text,
    actor: "",
  };
}

function renderSystemActivity(message) {
  const content = messageContent(message);
  const activity = classifySystemActivity(content);
  const row = createElement("div", `system-event system-event-${activity.type}`);
  const icon = createElement("span", "system-event-icon", activity.icon);
  const body = createElement("div", "system-event-body");
  const heading = createElement("div", "system-event-heading");
  heading.appendChild(createElement("strong", null, activity.action));

  const detail = createElement("div", "system-event-detail");
  if (activity.type === "label" && activity.label) {
    detail.appendChild(createLabelChip(activity.label, { compact: true }));
    if (activity.actor) detail.appendChild(createElement("span", null, `por ${activity.actor}`));
  } else if (activity.type === "assignment" && activity.target) {
    detail.appendChild(createElement("strong", null, activity.target));
    if (activity.actor) detail.appendChild(createElement("span", null, `por ${activity.actor}`));
  } else if (activity.actor) {
    detail.appendChild(createElement("span", null, `por ${activity.actor}`));
  } else if (activity.detail) {
    detail.appendChild(createElement("span", null, activity.detail));
  }

  body.append(heading, detail);
  const time = createElement(
    "time",
    "system-event-time",
    formatDate(message.created_at)
  );
  row.append(icon, body, time);
  return row;
}

function updateSystemEventsToggle(messages) {
  if (!elements.toggleSystemEvents) return;
  const count = messages.filter(isSystemActivityMessage).length;
  elements.toggleSystemEvents.classList.toggle("is-hidden", count === 0);
  elements.toggleSystemEvents.textContent = state.showSystemEvents
    ? `Ocultar atividades (${count})`
    : `Mostrar atividades (${count})`;
  elements.toggleSystemEvents.setAttribute("aria-pressed", String(state.showSystemEvents));
}

function toggleSystemEvents() {
  state.showSystemEvents = !state.showSystemEvents;
  renderMessages(state.currentMessages);
}

async function loadMessages() {
  const conversationId = state.currentConversationId;
  if (!conversationId) return;

  elements.messageThread.replaceChildren(createElement("div", "empty-state", "Carregando mensagens..."));
  try {
    const data = await apiRequest(
      `/api/v1/accounts/${state.accountId}/conversations/${conversationId}/messages`
    );
    const messages = data?.payload || data?.data?.payload || (Array.isArray(data) ? data : []);
    renderMessages(messages);
  } catch (error) {
    elements.messageThread.replaceChildren(
      createElement("div", "empty-state", `Erro ao carregar mensagens: ${error.message}`)
    );
  }
}

function renderMessages(messages) {
  const normalizedMessages = Array.isArray(messages) ? messages : [];
  state.currentMessages = normalizedMessages;
  updateSystemEventsToggle(normalizedMessages);
  elements.messageThread.replaceChildren();

  if (!normalizedMessages.length) {
    elements.messageThread.appendChild(createElement("div", "empty-state", "Nenhuma mensagem disponível."));
    return;
  }

  let renderedCount = 0;
  for (const message of normalizedMessages) {
    const content = messageContent(message);
    if (!content) continue;

    if (isSystemActivityMessage(message)) {
      if (!state.showSystemEvents) continue;
      elements.messageThread.appendChild(renderSystemActivity(message));
      renderedCount += 1;
      continue;
    }

    const isPrivate = Boolean(message.private);
    const outgoing = Number(message.message_type) === 1 || message.message_type === "outgoing";
    const bubble = createElement(
      "div",
      `message-bubble ${isPrivate ? "private" : outgoing ? "outgoing" : "incoming"}`
    );
    bubble.appendChild(createElement("div", null, content));
    bubble.appendChild(
      createElement(
        "span",
        "message-meta",
        `${message.sender?.name || (outgoing ? "Atendente" : "Contato")} · ${formatDate(message.created_at)}`
      )
    );
    elements.messageThread.appendChild(bubble);
    renderedCount += 1;
  }

  if (!renderedCount) {
    elements.messageThread.appendChild(
      createElement(
        "div",
        "empty-state",
        state.showSystemEvents
          ? "Nenhum item disponível neste histórico."
          : "Nenhuma mensagem do cliente ou da equipe. Use “Mostrar atividades” para ver eventos do sistema."
      )
    );
  }

  elements.messageThread.scrollTop = elements.messageThread.scrollHeight;
}

function attachmentDescription(message) {
  const attachments = message.attachments || (message.attachment ? [message.attachment] : []);
  if (!attachments.length) return "";
  return `[${attachments[0].file_type || attachments[0].extension || "arquivo"}]`;
}

async function saveOpportunity() {
  if (!hasPermission("opportunities:write")) {
    showToast("Seu perfil possui acesso somente para leitura.", "error");
    return;
  }
  const conversationId = state.currentConversationId;
  const conversation = state.conversations.find((item) => Number(item.id) === conversationId);
  if (!conversation) return;

  const selectedStage = elements.drawerStage.value;
  const selectedValue = Number(elements.drawerValue.value || 0);
  const selectedLossReason = elements.drawerLossReason.value.trim();
  if (selectedStage === "won" && (!Number.isFinite(selectedValue) || selectedValue <= 0)) {
    showToast("Informe um valor maior que zero antes de marcar como ganho.", "error");
    elements.drawerValue.focus();
    return;
  }
  if (selectedStage === "lost" && !selectedLossReason) {
    showToast("Informe o motivo da perda antes de salvar.", "error");
    elements.drawerLossReason.focus();
    return;
  }

  elements.saveOpportunity.disabled = true;
  try {
    const previousAttributes = getCustomAttributes(conversation);
    const previousDone = isTrue(previousAttributes.crm_task_done);
    const nextTask = elements.drawerTask.value.trim();
    const nextDone = Boolean(nextTask && elements.drawerTaskDone.checked);
    let completedAt = previousAttributes.crm_task_completed_at || null;
    if (nextDone && (!previousDone || !completedAt)) completedAt = new Date().toISOString();
    if (!nextDone) completedAt = null;

    const customAttributes = {
      ...previousAttributes,
      crm_stage: elements.drawerStage.value,
      crm_value: elements.drawerValue.value ? Number(elements.drawerValue.value) : null,
      crm_next_task: nextTask,
      crm_task_due_at: elements.drawerDueDate.value || null,
      crm_task_done: nextDone,
      crm_task_completed_at: completedAt,
      crm_loss_reason: elements.drawerStage.value === "lost" ? elements.drawerLossReason.value.trim() : "",
    };

    await updateCustomAttributes(conversationId, customAttributes);

    const priority = elements.drawerPriority.value;
    if ((conversation.priority || "none") !== priority) {
      await apiRequest(`/api/v1/accounts/${state.accountId}/conversations/${conversationId}`, {
        method: "PATCH",
        body: JSON.stringify({ priority }),
      });
    }

    const currentAssigneeId = getAssignee(conversation)?.id ? String(getAssignee(conversation).id) : "";
    const currentTeamId = getTeam(conversation)?.id ? String(getTeam(conversation).id) : "";
    const selectedAssignee = elements.drawerAssignee.value;
    const selectedTeam = elements.drawerTeam.value;

    if (
      hasPermission("assignments:manage") &&
      (selectedAssignee !== currentAssigneeId || (!selectedAssignee && selectedTeam !== currentTeamId))
    ) {
      const assignment = {};
      if (selectedAssignee) assignment.assignee_id = Number(selectedAssignee);
      else if (selectedTeam) assignment.team_id = Number(selectedTeam);
      else assignment.assignee_id = 0;

      await apiRequest(
        `/api/v1/accounts/${state.accountId}/conversations/${conversationId}/assignments`,
        {
          method: "POST",
          body: JSON.stringify(assignment),
        }
      );
    }

    conversation.custom_attributes = customAttributes;
    conversation.priority = priority;
    conversation.meta = conversation.meta || {};
    conversation.meta.assignee = selectedAssignee
      ? state.agents.find((agent) => String(agent.id) === selectedAssignee) || null
      : null;
    conversation.meta.team = selectedTeam
      ? state.teams.find((team) => String(team.id) === selectedTeam) || null
      : null;

    if (!belongsToCurrentScope(conversation)) {
      state.conversations = state.conversations.filter(
        (item) => Number(item.id) !== Number(conversation.id)
      );
      closeOpportunityDrawer();
    }

    elements.drawerTaskCompletedAt.dataset.value = completedAt || "";
    updateDrawerTaskState();

    renderAll();
    showToast("Oportunidade atualizada.", "success");
  } catch (error) {
    showToast(`Erro ao salvar: ${error.message}`, "error");
  } finally {
    elements.saveOpportunity.disabled = false;
  }
}

async function updateCustomAttributes(conversationId, customAttributes) {
  return apiRequest(`/api/crm/opportunities/${conversationId}/custom-attributes`, {
    method: "POST",
    body: JSON.stringify({ custom_attributes: customAttributes }),
  });
}

async function sendReply(event) {
  event.preventDefault();
  if (!hasPermission("messages:send")) {
    showToast("Seu perfil não pode enviar mensagens.", "error");
    return;
  }
  const conversationId = state.currentConversationId;
  const content = elements.replyContent.value.trim();
  if (!conversationId || !content) return;

  elements.replySubmit.disabled = true;
  try {
    await apiRequest(
      `/api/v1/accounts/${state.accountId}/conversations/${conversationId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          content,
          message_type: "outgoing",
          private: elements.replyPrivate.checked,
          content_type: "text",
          content_attributes: {},
        }),
      }
    );
    const wasPrivate = elements.replyPrivate.checked;
    elements.replyContent.value = "";
    elements.replyPrivate.checked = false;
    showToast(wasPrivate ? "Nota privada criada." : "Mensagem enviada.", "success");
    await loadMessages();
    await refreshSingleConversation(conversationId);
  } catch (error) {
    showToast(`Falha ao enviar: ${error.message}`, "error");
  } finally {
    elements.replySubmit.disabled = false;
  }
}

async function refreshSingleConversation(conversationId) {
  try {
    const updated = await apiRequest(
      `/api/v1/accounts/${state.accountId}/conversations/${conversationId}`
    );
    const conversation = updated?.data || updated?.payload || updated;
    const index = state.conversations.findIndex((item) => Number(item.id) === Number(conversationId));
    if (index >= 0 && conversation?.id) {
      state.conversations[index] = conversation;
      state.conversations.sort(
        (a, b) => conversationActivityTimestamp(b) - conversationActivityTimestamp(a)
      );
      renderAll();
    }
  } catch (error) {
    console.warn("Não foi possível atualizar a conversa após o envio:", error.message);
  }
}

async function openInChatwootById(conversationId) {
  if (!conversationId) return;
  try {
    const data = await apiRequest(`/build-url-to-redirect?conversationId=${conversationId}`);
    window.open(data.url, "_blank", "noopener,noreferrer");
  } catch (error) {
    showToast(`Não foi possível abrir o Chatwoot: ${error.message}`, "error");
  }
}

async function openInChatwoot() {
  const conversationId = state.currentConversationId;
  if (!conversationId) return;
  try {
    const data = await apiRequest(`/build-url-to-redirect?conversationId=${conversationId}`);
    window.open(data.url, "_blank", "noopener,noreferrer");
  } catch (error) {
    showToast(`Não foi possível abrir o Chatwoot: ${error.message}`, "error");
  }
}

async function bootstrapCrm() {
  elements.bootstrapCrm.disabled = true;
  elements.bootstrapResult.textContent = "Configurando atributos...";
  try {
    const result = await apiRequest("/api/crm/bootstrap", { method: "POST" });
    elements.bootstrapResult.textContent = [
      `Criados: ${result.created?.length ? result.created.join(", ") : "nenhum"}`,
      `Já existentes: ${result.skipped?.length ? result.skipped.join(", ") : "nenhum"}`,
      result.errors?.length ? `Erros: ${JSON.stringify(result.errors, null, 2)}` : "Configuração concluída.",
    ].join("\n");
    if (!result.errors?.length) await syncStageValues({ silent: false });
    showToast("Atributos CRM verificados.", result.errors?.length ? "error" : "success");
  } catch (error) {
    elements.bootstrapResult.textContent = `Erro: ${error.message}`;
    showToast(`Falha na configuração: ${error.message}`, "error");
  } finally {
    elements.bootstrapCrm.disabled = false;
  }
}

function currentFilterSnapshot() {
  return { search: state.search, filters: { ...state.filters } };
}

function persistFilterPresets() {
  if (state.activeFilterPresetId) {
    window.localStorage.setItem(STORAGE_KEYS.activePreset, state.activeFilterPresetId);
  } else {
    window.localStorage.removeItem(STORAGE_KEYS.activePreset);
  }
}

function restoreActiveFilterPreset() {
  if (!state.activeFilterPresetId) return;
  const preset = state.filterPresets.find((item) => item.id === state.activeFilterPresetId);
  if (!preset) {
    state.activeFilterPresetId = "";
    persistFilterPresets();
    return;
  }
  state.search = preset.search || "";
  state.filters = { ...state.filters, ...(preset.filters || {}) };
  elements.globalSearch.value = state.search;
  elements.filterAssignee.value = state.filters.assignee || "";
  elements.filterTeam.value = state.filters.team || "";
  elements.filterInbox.value = state.filters.inbox || "";
  elements.filterLabel.value = state.filters.label || "";
  elements.filterPriority.value = state.filters.priority || "";
  elements.filterTaskStatus.value = state.filters.taskStatus || "";
}

function renderFilterPresets() {
  if (!elements.filterPreset) return;
  elements.filterPreset.replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "Filtros salvos";
  elements.filterPreset.appendChild(empty);
  for (const preset of state.filterPresets) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = `${preset.scope === "shared" ? "Equipe · " : "Meu · "}${preset.name}`;
    elements.filterPreset.appendChild(option);
  }
  elements.filterPreset.value = state.activeFilterPresetId;
  const active = state.filterPresets.find((item) => item.id === state.activeFilterPresetId);
  const canDelete = Boolean(
    active &&
      (active.ownerUserId === state.user?.id ||
        (active.scope === "shared" && hasPermission("filters:share")))
  );
  elements.deleteFilterPreset.disabled = !canDelete;
}

async function saveCurrentFilterPreset() {
  const name = window.prompt("Nome para este conjunto de filtros:");
  if (!name || !name.trim()) return;
  const scope = hasPermission("filters:share") && window.confirm("Compartilhar este filtro com toda a equipe?")
    ? "shared"
    : "personal";
  try {
    const result = await apiRequest("/api/crm/filters", {
      method: "POST",
      body: JSON.stringify({
        name: name.trim().slice(0, 60),
        scope,
        snapshot: currentFilterSnapshot(),
      }),
    });
    state.filterPresets.push(result.preset);
    state.activeFilterPresetId = result.preset.id;
    persistFilterPresets();
    renderFilterPresets();
    showToast(scope === "shared" ? "Filtro compartilhado com a equipe." : "Filtro pessoal salvo.", "success");
  } catch (error) {
    showToast(`Não foi possível salvar o filtro: ${error.message}`, "error");
  }
}

function applyFilterPreset(presetId) {
  state.activeFilterPresetId = presetId;
  const preset = state.filterPresets.find((item) => item.id === presetId);
  if (!preset) {
    persistFilterPresets();
    renderFilterPresets();
    return;
  }
  state.search = preset.search || "";
  state.filters = { ...state.filters, ...(preset.filters || {}) };
  elements.globalSearch.value = state.search;
  elements.filterAssignee.value = state.filters.assignee || "";
  elements.filterTeam.value = state.filters.team || "";
  elements.filterInbox.value = state.filters.inbox || "";
  elements.filterLabel.value = state.filters.label || "";
  elements.filterPriority.value = state.filters.priority || "";
  elements.filterTaskStatus.value = state.filters.taskStatus || "";
  persistFilterPresets();
  renderFilterPresets();
  renderAll();
}

async function deleteActiveFilterPreset() {
  if (!state.activeFilterPresetId) return;
  const preset = state.filterPresets.find((item) => item.id === state.activeFilterPresetId);
  if (!preset || !window.confirm(`Excluir o filtro salvo “${preset.name}”?`)) return;
  try {
    await apiRequest(`/api/crm/filters/${preset.id}`, { method: "DELETE" });
    state.filterPresets = state.filterPresets.filter((item) => item.id !== preset.id);
    state.activeFilterPresetId = "";
    persistFilterPresets();
    renderFilterPresets();
    showToast("Filtro excluído.", "success");
  } catch (error) {
    showToast(`Não foi possível excluir o filtro: ${error.message}`, "error");
  }
}

function renderStageManager() {
  if (!elements.stageManagerList) return;
  const canManage = hasPermission("pipeline:manage");
  elements.stageManagerList.replaceChildren();
  for (const [index, stage] of getAllPipelineStages().entries()) {
    const row = createElement("div", `stage-manager-row ${stage.archived ? "is-archived" : ""}`);
    const color = document.createElement("input");
    color.type = "color";
    color.value = stage.color;
    color.title = "Cor da etapa";
    color.disabled = !canManage;
    color.addEventListener("change", async () => {
      const previous = stage.color;
      stage.color = color.value;
      try {
        await savePipelineStages({ silent: false });
        renderAll();
        showToast("Cor da etapa atualizada para toda a equipe.", "success");
      } catch (error) {
        stage.color = previous;
        color.value = previous;
        showToast(`Não foi possível atualizar a etapa: ${error.message}`, "error");
      }
    });
    const name = document.createElement("input");
    name.type = "text";
    name.value = stage.label;
    name.maxLength = 60;
    name.disabled = !canManage;
    name.addEventListener("change", async () => {
      const next = name.value.trim();
      if (!next) {
        name.value = stage.label;
        return;
      }
      const previous = stage.label;
      stage.label = next;
      try {
        await savePipelineStages({ silent: false });
        populateDrawerOptions();
        renderAll();
        showToast("Nome da etapa atualizado para toda a equipe.", "success");
      } catch (error) {
        stage.label = previous;
        name.value = previous;
        showToast(`Não foi possível atualizar a etapa: ${error.message}`, "error");
      }
    });
    const code = createElement("code", null, stage.id);
    const controls = createElement("div", "stage-manager-actions");
    const up = createElement("button", "icon-button-small", "↑");
    const down = createElement("button", "icon-button-small", "↓");
    const archive = createElement("button", "button button-ghost button-small", stage.archived ? "Reativar" : "Arquivar");
    const remove = createElement("button", "button button-danger button-small", "Excluir");
    up.type = down.type = archive.type = remove.type = "button";
    up.disabled = !canManage || index === 0;
    down.disabled = !canManage || index === getAllPipelineStages().length - 1;
    remove.disabled = !canManage || stage.locked;
    archive.disabled = !canManage || stage.locked;
    up.addEventListener("click", () => reorderStage(index, index - 1));
    down.addEventListener("click", () => reorderStage(index, index + 1));
    archive.addEventListener("click", () => toggleStageArchive(stage.id));
    remove.addEventListener("click", () => deleteStage(stage.id));
    controls.append(up, down, archive, remove);
    const info = createElement("div", "stage-manager-info");
    info.append(name, code);
    row.append(color, info, controls);
    elements.stageManagerList.appendChild(row);
  }
  if (elements.stageManagerForm) {
    elements.stageManagerForm.querySelectorAll("input, button").forEach((element) => {
      element.disabled = !canManage;
    });
  }
}

async function reorderStage(fromIndex, toIndex) {
  if (!hasPermission("pipeline:manage")) return;
  if (toIndex < 0 || toIndex >= state.pipelineStages.length) return;
  const previous = state.pipelineStages.map((stage) => ({ ...stage }));
  const [stage] = state.pipelineStages.splice(fromIndex, 1);
  state.pipelineStages.splice(toIndex, 0, stage);
  try {
    await savePipelineStages();
    renderStageManager();
    populateDrawerOptions();
    renderAll();
  } catch (error) {
    state.pipelineStages = previous;
    renderStageManager();
    showToast(`Não foi possível reordenar: ${error.message}`, "error");
  }
}

function stageOpportunityCount(stageId) {
  return state.conversations.filter((conversation) => getConversationStage(conversation) === stageId).length;
}

async function toggleStageArchive(stageId) {
  if (!hasPermission("pipeline:manage")) return;
  const stage = getStage(stageId);
  if (stage.locked) return;
  if (!stage.archived && stageOpportunityCount(stageId) > 0) {
    showToast("Mova as oportunidades desta etapa antes de arquivá-la.", "error");
    return;
  }
  stage.archived = !stage.archived;
  try {
    await savePipelineStages();
    renderStageManager();
    populateDrawerOptions();
    renderAll();
    showToast(stage.archived ? "Etapa arquivada para toda a equipe." : "Etapa reativada.", "success");
  } catch (error) {
    stage.archived = !stage.archived;
    renderStageManager();
    showToast(`Não foi possível atualizar a etapa: ${error.message}`, "error");
  }
}

async function deleteStage(stageId) {
  if (!hasPermission("pipeline:manage")) return;
  const stage = getStage(stageId);
  if (stage.locked) return;
  if (stageOpportunityCount(stageId) > 0) {
    showToast("Não é possível excluir uma etapa que contém oportunidades.", "error");
    return;
  }
  if (!window.confirm(`Excluir a etapa “${stage.label}” para todos os usuários?`)) return;
  const previous = state.pipelineStages.map((item) => ({ ...item }));
  state.pipelineStages = state.pipelineStages.filter((item) => item.id !== stageId);
  try {
    await savePipelineStages();
    renderStageManager();
    populateDrawerOptions();
    renderAll();
    showToast("Etapa excluída da configuração central.", "success");
  } catch (error) {
    state.pipelineStages = previous;
    renderStageManager();
    showToast(`Não foi possível excluir a etapa: ${error.message}`, "error");
  }
}

async function addPipelineStage(event) {
  event.preventDefault();
  if (!hasPermission("pipeline:manage")) return;
  const label = elements.newStageName.value.trim();
  const color = elements.newStageColor.value;
  let id = slugifyStage(label);
  if (!label || !id) return;
  if (getAllPipelineStages().some((stage) => stage.id === id)) {
    id = `${id}_${Date.now().toString().slice(-5)}`;
  }
  const previous = state.pipelineStages.map((item) => ({ ...item }));
  state.pipelineStages.push({ id, label: label.slice(0, 60), color, archived: false });
  try {
    const response = await savePipelineStages();
    elements.newStageName.value = "";
    renderStageManager();
    populateDrawerOptions();
    renderAll();
    showToast(
      response.stageSync?.ok
        ? "Etapa criada e compartilhada com a equipe."
        : "Etapa criada no CRM; revise a sincronização com o Chatwoot.",
      response.stageSync?.ok ? "success" : "error"
    );
  } catch (error) {
    state.pipelineStages = previous;
    renderStageManager();
    showToast(`Não foi possível criar a etapa: ${error.message}`, "error");
  }
}

async function syncStageValues(options = {}) {
  try {
    const result = await apiRequest("/api/crm/stages/sync", { method: "POST" });
    return Boolean(result.ok ?? true);
  } catch (error) {
    console.warn("Não foi possível sincronizar valores de crm_stage:", error.message);
    if (!options.silent) showToast(`Falha ao sincronizar etapas: ${error.message}`, "error");
    return false;
  }
}

async function loadAdministrationData(options = {}) {
  const requests = [];
  if (hasPermission("users:manage")) {
    requests.push(
      apiRequest("/api/crm/users")
        .then((result) => {
          state.users = Array.isArray(result.users) ? result.users : [];
          renderUsers();
        })
        .catch((error) => {
          if (!options.silent) showToast(`Falha ao carregar usuários: ${error.message}`, "error");
        })
    );
  }
  if (hasPermission("audit:read")) {
    requests.push(
      apiRequest("/api/crm/audit?limit=60")
        .then((result) => {
          state.audit = Array.isArray(result.audit) ? result.audit : [];
          renderAudit();
        })
        .catch((error) => {
          if (!options.silent) showToast(`Falha ao carregar auditoria: ${error.message}`, "error");
        })
    );
  }
  await Promise.all(requests);
}

function populateUserAgentOptions() {
  if (!elements.crmUserAgent) return;
  const current = elements.crmUserAgent.value;
  fillSelect(
    elements.crmUserAgent,
    state.agents.map((agent) => ({ id: agent.id, name: agent.name || agent.email || `Agente #${agent.id}` })),
    "Selecione o agente do Chatwoot"
  );
  if ([...elements.crmUserAgent.options].some((option) => option.value === current)) {
    elements.crmUserAgent.value = current;
  }
}

function defaultScopeForRole(role) {
  return {
    admin: "all",
    manager: "all",
    sdr: "unassigned_and_mine",
    seller: "mine",
    agent: "all",
    viewer: "all",
  }[role] || "all";
}

function renderUsers() {
  if (!elements.crmUsersList) return;
  elements.crmUsersList.replaceChildren();
  if (!state.users.length) {
    elements.crmUsersList.appendChild(createElement("div", "empty-state", "Nenhum usuário cadastrado."));
    return;
  }
  for (const user of state.users) {
    const row = createElement("div", `crm-user-row crm-user-row-operational ${user.active ? "" : "is-disabled"}`);
    const info = createElement("div", "crm-user-info");
    const linkedAgent = state.agents.find(
      (agent) => Number(agent.id) === Number(user.chatwootAgentId)
    );
    info.append(
      createElement("strong", null, user.name),
      createElement(
        "span",
        null,
        `${user.email} · ${roleLabel(user.operationalRole || user.role)} · ${scopeLabel(user.visibilityScope, user.operationalRole || user.role)}`
      ),
      createElement(
        "small",
        user.chatwootAgentId ? "linked-agent-ok" : "linked-agent-warning",
        linkedAgent?.name || (user.chatwootAgentId ? `Agente #${user.chatwootAgentId}` : "Sem agente Chatwoot vinculado")
      )
    );

    const controls = createElement("div", "crm-user-actions crm-user-operational-controls");
    const role = document.createElement("select");
    for (const value of ["admin", "manager", "sdr", "seller", "viewer"]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = roleLabel(value);
      role.appendChild(option);
    }
    role.value = user.operationalRole || user.role;
    role.disabled = user.id === state.user?.id;
    role.addEventListener("change", async () => {
      const nextScope = defaultScopeForRole(role.value);
      await updateCrmUser(user.id, {
        operationalRole: role.value,
        visibilityScope: nextScope,
        chatwootAgentId: agent.value || null,
      });
    });

    const agent = document.createElement("select");
    fillSelect(
      agent,
      state.agents.map((item) => ({
        id: item.id,
        name: item.name || item.email || `Agente #${item.id}`,
      })),
      "Sem agente vinculado"
    );
    agent.value = user.chatwootAgentId ? String(user.chatwootAgentId) : "";
    agent.addEventListener("change", () =>
      updateCrmUser(user.id, { chatwootAgentId: agent.value || null })
    );

    const scope = document.createElement("select");
    for (const value of ["all", "unassigned_and_mine", "mine", "unassigned"]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = scopeLabel(value, user.operationalRole || user.role);
      scope.appendChild(option);
    }
    scope.value = user.visibilityScope || defaultScopeForRole(user.operationalRole || user.role);
    scope.disabled = ["admin", "manager"].includes(user.operationalRole || user.role);
    scope.addEventListener("change", () =>
      updateCrmUser(user.id, { visibilityScope: scope.value })
    );

    const resetPassword = createElement("button", "button button-ghost button-small", "Nova senha");
    resetPassword.type = "button";
    resetPassword.addEventListener("click", async () => {
      const password = window.prompt(`Nova senha para ${user.name} (mínimo 10 caracteres):`);
      if (!password) return;
      await updateCrmUser(user.id, { password });
    });
    const active = createElement(
      "button",
      `button button-small ${user.active ? "button-ghost" : "button-primary"}`,
      user.active ? "Desativar" : "Ativar"
    );
    active.type = "button";
    active.disabled = user.id === state.user?.id;
    active.addEventListener("click", () => updateCrmUser(user.id, { active: !user.active }));
    controls.append(role, agent, scope, resetPassword, active);
    row.append(info, controls);
    elements.crmUsersList.appendChild(row);
  }
}

async function handleCrmUserCreate(event) {
  event.preventDefault();
  if (!hasPermission("users:manage")) return;
  const payload = {
    name: elements.crmUserName.value.trim(),
    email: elements.crmUserEmail.value.trim(),
    password: elements.crmUserPassword.value,
    operationalRole: elements.crmUserRole.value,
    chatwootAgentId: elements.crmUserAgent.value || null,
    visibilityScope: elements.crmUserScope.value,
  };
  elements.crmUserSubmit.disabled = true;
  try {
    const result = await apiRequest("/api/crm/users", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    state.users.push(result.user);
    state.users.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    elements.crmUserForm.reset();
    elements.crmUserRole.value = "sdr";
    elements.crmUserScope.value = "unassigned_and_mine";
    renderUsers();
    await loadAdministrationData({ silent: true });
    showToast("Usuário criado com acesso centralizado.", "success");
  } catch (error) {
    showToast(`Não foi possível criar o usuário: ${error.message}`, "error");
  } finally {
    elements.crmUserSubmit.disabled = false;
  }
}

async function updateCrmUser(userId, changes) {
  try {
    const result = await apiRequest(`/api/crm/users/${userId}`, {
      method: "PATCH",
      body: JSON.stringify(changes),
    });
    const index = state.users.findIndex((item) => item.id === userId);
    if (index >= 0) state.users[index] = result.user;
    if (userId === state.user?.id) {
      state.user = {
        ...state.user,
        role: result.user.role,
        operationalRole: result.user.operationalRole,
        chatwootAgentId: result.user.chatwootAgentId,
        visibilityScope: result.user.visibilityScope,
      };
      renderIdentity();
    }
    renderUsers();
    await loadAdministrationData({ silent: true });
    showToast("Acesso do usuário atualizado.", "success");
  } catch (error) {
    showToast(`Não foi possível atualizar o usuário: ${error.message}`, "error");
    await loadAdministrationData({ silent: true });
  }
}

function auditActionLabel(action) {
  return {
    "session.login": "Entrou no CRM",
    "session.logout": "Saiu do CRM",
    "organization.bootstrap": "Inicializou a organização",
    "crm.bootstrap": "Configurou atributos do CRM",
    "pipeline.stages.updated": "Atualizou etapas do pipeline",
    "filter.created": "Criou um filtro",
    "filter.deleted": "Excluiu um filtro",
    "user.created": "Criou um usuário",
    "user.updated": "Atualizou um usuário",
    "opportunity.updated": "Atualizou uma oportunidade",
    "conversation.labels.updated": "Atualizou etiquetas da conversa",
    "intervention.detected": "Detectou intervenção humana",
    "intervention.assumed": "Assumiu intervenção humana",
    "intervention.resolved": "Resolveu intervenção humana",
    "intervention.auto_resolved": "Intervenção encerrada após remoção das etiquetas",
    "chatwoot.message.created": "Enviou mensagem ou nota",
    "chatwoot.post": "Executou alteração no Chatwoot",
    "chatwoot.patch": "Atualizou dados no Chatwoot",
  }[action] || action;
}

function renderAudit() {
  if (!elements.auditList) return;
  elements.auditList.replaceChildren();
  if (!state.audit.length) {
    elements.auditList.appendChild(createElement("div", "empty-state", "Nenhuma atividade registrada."));
    return;
  }
  for (const entry of state.audit) {
    const row = createElement("div", "audit-row");
    const info = createElement("div", "audit-info");
    info.append(
      createElement("strong", null, auditActionLabel(entry.action)),
      createElement(
        "span",
        null,
        `${entry.actorName || "Sistema"}${entry.entityId ? ` · #${entry.entityId}` : ""}`
      )
    );
    row.append(info, createElement("time", null, formatDate(entry.createdAt)));
    elements.auditList.appendChild(row);
  }
}

function statusLabel(status) {
  const labels = {
    open: "Em aberto",
    pending: "Pendente",
    resolved: "Resolvida",
    snoozed: "Adiada",
  };
  return labels[status] || status || "—";
}

function switchView(viewName) {
  state.currentView = viewName;
  document.querySelectorAll(".view").forEach((view) => view.classList.remove("is-active"));
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("is-active"));
  byId(`view-${viewName}`)?.classList.add("is-active");
  document.querySelector(`.nav-item[data-view="${viewName}"]`)?.classList.add("is-active");

  const titles = {
    dashboard: ["VISÃO GERAL", "Dashboard comercial"],
    interventions: ["AÇÃO IMEDIATA", "Intervenções humanas"],
    pipeline: ["OPORTUNIDADES", "Pipeline de vendas"],
    conversations: ["ATENDIMENTO", "Conversas do Chatwoot"],
    tasks: ["PRODUTIVIDADE", "Tarefas comerciais"],
    contacts: ["RELACIONAMENTO", "Contatos"],
    settings: ["ADMINISTRAÇÃO", "Configurações"],
  };
  const [eyebrow, title] = titles[viewName] || titles.dashboard;
  elements.pageEyebrow.textContent = eyebrow;
  elements.pageTitle.textContent = title;
}

function clearFilters() {
  state.search = "";
  elements.globalSearch.value = "";
  state.filters = {
    assignee: "",
    team: "",
    inbox: "",
    label: "",
    priority: "",
    taskStatus: "",
  };
  elements.filterAssignee.value = "";
  elements.filterTeam.value = "";
  elements.filterInbox.value = "";
  elements.filterLabel.value = "";
  elements.filterPriority.value = "";
  elements.filterTaskStatus.value = "";
  state.activeFilterPresetId = "";
  persistFilterPresets();
  renderFilterPresets();
  renderAll();
}

function configureAutoRefresh() {
  if (state.refreshTimer) window.clearInterval(state.refreshTimer);
  if (state.syncStatusTimer) window.clearInterval(state.syncStatusTimer);

  state.refreshTimer = window.setInterval(() => {
    if (
      elements.autoRefreshToggle?.checked &&
      !document.hidden &&
      !elements.app.classList.contains("is-hidden")
    ) {
      loadWorkspace({ background: true });
    }
  }, 60000);

  state.syncStatusTimer = window.setInterval(updateSyncStatus, 15000);
}

function cacheElements() {
  Object.assign(elements, {
    loginScreen: byId("login-screen"),
    loginForm: byId("login-form"),
    loginEmail: byId("login-email"),
    loginPassword: byId("login-password"),
    loginSubmit: byId("login-submit"),
    loginError: byId("login-error"),
    app: byId("app"),
    sidebarAccountId: byId("sidebar-account-id"),
    sidebarUserName: byId("sidebar-user-name"),
    sidebarUserRole: byId("sidebar-user-role"),
    settingsAccountId: byId("settings-account-id"),
    settingsOrganizationName: byId("settings-organization-name"),
    settingsCurrentUser: byId("settings-current-user"),
    settingsCurrentScope: byId("settings-current-scope"),
    settingsLinkedAgent: byId("settings-linked-agent"),
    pageEyebrow: byId("page-eyebrow"),
    pageTitle: byId("page-title"),
    globalSearch: byId("global-search"),
    refreshButton: byId("refresh-button"),
    lastSync: byId("last-sync"),
    autoRefreshToggle: byId("auto-refresh-toggle"),
    metricsGrid: byId("metrics-grid"),
    interventionNavCount: byId("intervention-nav-count"),
    interventionViewCount: byId("intervention-view-count"),
    interventionList: byId("intervention-list"),
    stageOverview: byId("stage-overview"),
    dashboardTasks: byId("dashboard-tasks"),
    recentConversations: byId("recent-conversations"),
    pipelineBoard: byId("pipeline-board"),
    filterAssignee: byId("filter-assignee"),
    filterTeam: byId("filter-team"),
    filterInbox: byId("filter-inbox"),
    filterLabel: byId("filter-label"),
    filterPriority: byId("filter-priority"),
    filterTaskStatus: byId("filter-task-status"),
    clearFilters: byId("clear-filters"),
    filterPreset: byId("filter-preset"),
    saveFilterPreset: byId("save-filter-preset"),
    deleteFilterPreset: byId("delete-filter-preset"),
    managePipeline: byId("manage-pipeline"),
    pipelineResultCount: byId("pipeline-result-count"),
    conversationCount: byId("conversation-count"),
    conversationsTable: byId("conversations-table"),
    taskCount: byId("task-count"),
    taskSummary: byId("task-summary"),
    tasksList: byId("tasks-list"),
    contactCount: byId("contact-count"),
    contactsTable: byId("contacts-table"),
    bootstrapCrm: byId("bootstrap-crm"),
    bootstrapResult: byId("bootstrap-result"),
    pipelineSettingsPanel: byId("pipeline-settings-panel"),
    stageManagerList: byId("stage-manager-list"),
    stageManagerForm: byId("stage-manager-form"),
    newStageName: byId("new-stage-name"),
    newStageColor: byId("new-stage-color"),
    userManagementPanel: byId("user-management-panel"),
    crmUserForm: byId("crm-user-form"),
    crmUserName: byId("crm-user-name"),
    crmUserEmail: byId("crm-user-email"),
    crmUserPassword: byId("crm-user-password"),
    crmUserRole: byId("crm-user-role"),
    crmUserAgent: byId("crm-user-agent"),
    crmUserScope: byId("crm-user-scope"),
    crmUserSubmit: byId("crm-user-submit"),
    crmUsersList: byId("crm-users-list"),
    auditPanel: byId("audit-panel"),
    auditList: byId("audit-list"),
    refreshAdministration: byId("refresh-administration"),
    logoutButton: byId("logout-button"),
    drawer: byId("opportunity-drawer"),
    drawerConversationId: byId("drawer-conversation-id"),
    drawerContactName: byId("drawer-contact-name"),
    drawerContactMeta: byId("drawer-contact-meta"),
    drawerInterventionPanel: byId("drawer-intervention-panel"),
    drawerInterventionTitle: byId("drawer-intervention-title"),
    drawerInterventionDescription: byId("drawer-intervention-description"),
    assumeIntervention: byId("assume-intervention"),
    resolveIntervention: byId("resolve-intervention"),
    drawerStage: byId("drawer-stage"),
    drawerValue: byId("drawer-value"),
    drawerPriority: byId("drawer-priority"),
    drawerAssignee: byId("drawer-assignee"),
    drawerTeam: byId("drawer-team"),
    drawerTask: byId("drawer-task"),
    drawerDueDate: byId("drawer-due-date"),
    drawerTaskDone: byId("drawer-task-done"),
    drawerTaskState: byId("drawer-task-state"),
    drawerTaskCompletedAt: byId("drawer-task-completed-at"),
    lossReasonField: byId("loss-reason-field"),
    drawerLossReason: byId("drawer-loss-reason"),
    drawerLabels: byId("drawer-labels"),
    drawerLabelEditor: byId("drawer-label-editor"),
    drawerLabelSearch: byId("drawer-label-search"),
    drawerLabelOptions: byId("drawer-label-options"),
    toggleLabelEditor: byId("toggle-label-editor"),
    saveLabels: byId("save-labels"),
    cancelLabels: byId("cancel-labels"),
    saveOpportunity: byId("save-opportunity"),
    openChatwoot: byId("open-chatwoot"),
    reloadMessages: byId("reload-messages"),
    toggleSystemEvents: byId("toggle-system-events"),
    messageThread: byId("message-thread"),
    replyForm: byId("reply-form"),
    replyContent: byId("reply-content"),
    replyPrivate: byId("reply-private"),
    replySubmit: byId("reply-submit"),
    transitionModal: byId("transition-modal"),
    transitionForm: byId("transition-form"),
    transitionModalTitle: byId("transition-modal-title"),
    transitionModalDescription: byId("transition-modal-description"),
    transitionValueField: byId("transition-value-field"),
    transitionValue: byId("transition-value"),
    transitionReasonField: byId("transition-reason-field"),
    transitionReason: byId("transition-reason"),
    transitionConfirm: byId("transition-confirm"),
    loadingOverlay: byId("loading-overlay"),
    loadingMessage: byId("loading-message"),
    toastContainer: byId("toast-container"),
  });
}

function bindEvents() {
  elements.loginForm.addEventListener("submit", handleLogin);
  elements.logoutButton.addEventListener("click", logout);
  elements.refreshButton.addEventListener("click", () => loadWorkspace({ background: false }));
  elements.bootstrapCrm.addEventListener("click", bootstrapCrm);
  elements.clearFilters.addEventListener("click", clearFilters);
  elements.filterPreset.addEventListener("change", () => applyFilterPreset(elements.filterPreset.value));
  elements.saveFilterPreset.addEventListener("click", saveCurrentFilterPreset);
  elements.deleteFilterPreset.addEventListener("click", deleteActiveFilterPreset);
  elements.managePipeline.addEventListener("click", () => switchView("settings"));
  elements.stageManagerForm.addEventListener("submit", addPipelineStage);
  elements.crmUserForm?.addEventListener("submit", handleCrmUserCreate);
  elements.crmUserRole?.addEventListener("change", () => {
    elements.crmUserScope.value = defaultScopeForRole(elements.crmUserRole.value);
  });
  elements.refreshAdministration?.addEventListener("click", () => loadAdministrationData({ silent: false }));
  elements.transitionForm.addEventListener("submit", confirmTransition);
  document.querySelectorAll("[data-close-transition]").forEach((element) => {
    element.addEventListener("click", closeTransitionModal);
  });
  elements.drawerStage.addEventListener("change", toggleLossReason);
  elements.drawerTask.addEventListener("input", updateDrawerTaskState);
  elements.drawerDueDate.addEventListener("change", updateDrawerTaskState);
  elements.drawerTaskDone.addEventListener("change", updateDrawerTaskState);
  elements.toggleLabelEditor.addEventListener("click", () => toggleDrawerLabelEditor());
  elements.drawerLabelSearch.addEventListener("input", renderDrawerLabelOptions);
  elements.saveLabels.addEventListener("click", saveDrawerLabels);
  elements.cancelLabels.addEventListener("click", cancelDrawerLabelChanges);
  elements.saveOpportunity.addEventListener("click", saveOpportunity);
  elements.assumeIntervention.addEventListener("click", () => {
    if (state.currentConversationId) assumeIntervention(state.currentConversationId);
  });
  elements.resolveIntervention.addEventListener("click", () => {
    if (state.currentConversationId) resolveIntervention(state.currentConversationId);
  });
  elements.openChatwoot.addEventListener("click", openInChatwoot);
  elements.reloadMessages.addEventListener("click", loadMessages);
  elements.toggleSystemEvents?.addEventListener("click", toggleSystemEvents);
  elements.replyForm.addEventListener("submit", sendReply);

  document.querySelectorAll("[data-close-drawer]").forEach((element) => {
    element.addEventListener("click", closeOpportunityDrawer);
  });

  document.querySelectorAll(".nav-item[data-view]").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });

  document.querySelectorAll("[data-go-view]").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.goView));
  });

  elements.globalSearch.addEventListener("input", () => {
    state.search = elements.globalSearch.value;
    state.activeFilterPresetId = "";
    persistFilterPresets();
    renderFilterPresets();
    renderAll();
  });

  const filterBindings = [
    [elements.filterAssignee, "assignee"],
    [elements.filterTeam, "team"],
    [elements.filterInbox, "inbox"],
    [elements.filterLabel, "label"],
    [elements.filterPriority, "priority"],
    [elements.filterTaskStatus, "taskStatus"],
  ];

  for (const [select, key] of filterBindings) {
    select.addEventListener("change", () => {
      state.filters[key] = select.value;
      state.activeFilterPresetId = "";
      persistFilterPresets();
      renderFilterPresets();
      renderAll();
    });
  }

  document.querySelectorAll("[data-task-view-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.taskViewFilter = button.dataset.taskViewFilter || "all";
      renderTasks();
    });
  });

  document.querySelectorAll("[data-intervention-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.interventionFilter = button.dataset.interventionFilter || "all";
      document.querySelectorAll("[data-intervention-filter]").forEach((item) => {
        item.classList.toggle("button-primary", item === button);
        item.classList.toggle("button-ghost", item !== button);
      });
      renderInterventions();
    });
  });

  elements.autoRefreshToggle.addEventListener("change", () => {
    showToast(
      elements.autoRefreshToggle.checked
        ? "Atualização automática ativada."
        : "Atualização automática pausada.",
      "success"
    );
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (elements.transitionModal.classList.contains("is-open")) {
      closeTransitionModal();
    } else if (elements.drawer.classList.contains("is-open")) {
      closeOpportunityDrawer();
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  loadLocalConfiguration();
  cacheElements();
  bindEvents();
  renderFilterPresets();
  renderStageManager();
  configureAutoRefresh();
  initializeSession();
});
