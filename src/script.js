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
const PIPELINE_COLUMN_PAGE_SIZE = 50;
const INTERVENTION_LABELS = new Set(["precisa-humano", "atendimento-manual"]);

const state = {
  accountId: null,
  organization: null,
  user: null,
  permissions: [],
  users: [],
  audit: [],
  conversations: [],
  archivedConversations: [],
  presence: [],
  handoffTargets: [],
  transferRequests: [],
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
  pipelinePeriod: "7d",
  pipelinePeriodStart: "",
  pipelinePeriodEnd: "",
  historyType: "all",
  historyPeriod: "30d",
  historyPeriodStart: "",
  historyPeriodEnd: "",
  historyLimit: PIPELINE_COLUMN_PAGE_SIZE,
  archiveLimit: PIPELINE_COLUMN_PAGE_SIZE,
  columnLimits: {},
  pendingHandoffConversationId: null,
  pendingArchiveConversationId: null,
  pendingRedistributionRequestId: null,
  presenceTimer: null,
  monthlySalesGoal: { enabled: false, targetSales: 0 },
  monthlySalesGoalProgress: { enabled: false, targetSales: 0, currentSales: 0, percentage: 0 },
  tutorials: [],
  tutorialCategory: "all",
  tutorialTab: "watch",
  tutorialLoading: false,
  credit: {
    enabled: false,
    readOnly: true,
    periodPreset: "today",
    periodStart: "",
    periodEnd: "",
    opportunityFilter: "all",
    bankFilter: "",
    metrics: {
      cpfCollectedToday: 0,
      conversationCount: 0,
      additionalCpfCount: 0,
      processing: 0,
      waitingInput: 0,
      attentionRequired: 0,
    },
    items: [],
    loading: false,
    error: false,
  },
  reactivation: {
    configuration: null,
    candidates: [],
    manualCandidates: [],
    campaigns: [],
    summary: { campaigns: 0, sent: 0, replied: 0, blocked: 0, failed: 0, uncertain: 0, responseRate: 0 },
    selected: new Map(),
    period: "7d",
    search: "",
    loading: false,
  },
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
  if (role === "sdr") {
    return new Set([
      "new",
      "contacted",
      "qualification",
      "sem_resposta_followup",
      "nova_tentativa_cpf",
      "analise_manual",
      "credito_aprovado",
    ]);
  }
  if (role === "seller") {
    return new Set(["credito_aprovado", "proposal", "negotiation", "won", "lost"]);
  }
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

function isTerminalConversation(conversation) {
  return ["won", "lost"].includes(getConversationStage(conversation));
}

function outcomeTimestamp(conversation) {
  const attributes = getCustomAttributes(conversation);
  const explicit = Date.parse(String(attributes.crm_outcome_at || ""));
  if (Number.isFinite(explicit)) return explicit;
  return conversationActivityTimestamp(conversation);
}

function startOfDay(timestamp = Date.now()) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function periodBounds(period, customStart = "", customEnd = "") {
  const now = Date.now();
  const todayStart = startOfDay(now);
  if (period === "all") return { start: -Infinity, end: Infinity };
  if (period === "today") return { start: todayStart, end: todayStart + 24 * 60 * 60 * 1000 - 1 };
  if (period === "7d") return { start: todayStart - 6 * 24 * 60 * 60 * 1000, end: Infinity };
  if (period === "30d") return { start: todayStart - 29 * 24 * 60 * 60 * 1000, end: Infinity };
  if (period === "month") {
    const date = new Date(now);
    return { start: new Date(date.getFullYear(), date.getMonth(), 1).getTime(), end: Infinity };
  }
  if (period === "custom") {
    const start = /^\d{4}-\d{2}-\d{2}$/.test(customStart)
      ? Date.parse(`${customStart}T00:00:00`)
      : -Infinity;
    const end = /^\d{4}-\d{2}-\d{2}$/.test(customEnd)
      ? Date.parse(`${customEnd}T23:59:59`)
      : Infinity;
    return { start, end };
  }
  return { start: -Infinity, end: Infinity };
}

function matchesPeriod(conversation, period, customStart = "", customEnd = "") {
  const timestamp = outcomeTimestamp(conversation);
  const bounds = periodBounds(period, customStart, customEnd);
  return timestamp >= bounds.start && timestamp <= bounds.end;
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
    error.code = body?.code;
    if (response.status === 428 && body?.code === "PASSWORD_CHANGE_REQUIRED") {
      if (state.user) state.user.mustChangePassword = true;
      showPasswordChangeRequired();
    }
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
  state.monthlySalesGoal = config.monthlySalesGoal || { enabled: false, targetSales: 0 };
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
  elements.monthlyGoalSettingsPanel?.classList.toggle("is-hidden", !hasPermission("goals:manage"));
  elements.tutorialManageTab?.classList.toggle("is-hidden", !hasPermission("tutorials:manage"));
  if (!hasPermission("tutorials:manage") && state.tutorialTab === "manage") {
    state.tutorialTab = "watch";
  }
  renderTutorialTabs();
  renderMonthlyGoalSettings();
  elements.bootstrapCrm.disabled = !hasPermission("pipeline:manage");
  elements.managePipeline.disabled = !hasPermission("pipeline:manage");
  elements.saveOpportunity.disabled = !hasPermission("opportunities:write");
  if (elements.saveLabels) elements.saveLabels.disabled = !hasPermission("opportunities:write");
  elements.replySubmit.disabled = !hasPermission("messages:send");
  updateArchiveNavigation();
  updateReactivationNavigation();
  updateCreditNavigation();
  renderPresence();
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
      if (state.user?.mustChangePassword) {
        showPasswordChangeRequired();
        return;
      }
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
  elements.passwordChangeScreen.classList.add("is-hidden");
  elements.app.classList.add("is-hidden");
}

function showApplication() {
  elements.loginScreen.classList.add("is-hidden");
  elements.passwordChangeScreen.classList.add("is-hidden");
  elements.app.classList.remove("is-hidden");
  renderIdentity();
}

function showPasswordChangeRequired() {
  elements.loginScreen.classList.add("is-hidden");
  elements.app.classList.add("is-hidden");
  elements.passwordChangeScreen.classList.remove("is-hidden");
  elements.requiredPasswordError.textContent = "";
  elements.requiredNewPassword.focus();
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
    if (state.user?.mustChangePassword) {
      showPasswordChangeRequired();
      return;
    }
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

async function handleRequiredPasswordChange(event) {
  event.preventDefault();
  elements.requiredPasswordError.textContent = "";
  elements.requiredPasswordSubmit.disabled = true;
  elements.requiredPasswordSubmit.textContent = "Salvando...";

  try {
    const response = await apiRequest("/api/account/password", {
      method: "PUT",
      body: JSON.stringify({
        newPassword: elements.requiredNewPassword.value,
        newPasswordConfirmation: elements.requiredNewPasswordConfirmation.value,
      }),
    });
    applySessionPayload(response);
    elements.requiredPasswordForm.reset();
    showApplication();
    await loadCentralConfiguration({ skipRender: true });
    renderIdentity();
    await loadWorkspace({ skipCentralReload: true });
    showToast("Sua nova senha foi criada.", "success");
  } catch (error) {
    elements.requiredPasswordError.textContent = error.message;
  } finally {
    elements.requiredPasswordSubmit.disabled = false;
    elements.requiredPasswordSubmit.textContent = "Salvar nova senha";
  }
}

function openPasswordChangeModal() {
  elements.accountPasswordForm.reset();
  elements.accountPasswordResult.textContent = "";
  elements.accountPasswordResult.classList.remove("is-success");
  elements.passwordChangeModal.classList.add("is-open");
  elements.passwordChangeModal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  window.setTimeout(() => elements.accountCurrentPassword.focus(), 60);
}

function closePasswordChangeModal() {
  elements.passwordChangeModal.classList.remove("is-open");
  elements.passwordChangeModal.setAttribute("aria-hidden", "true");
  elements.accountPasswordForm.reset();
  elements.accountPasswordResult.textContent = "";
  elements.accountPasswordResult.classList.remove("is-success");
  document.body.style.overflow = "";
}

async function handleVoluntaryPasswordChange(event) {
  event.preventDefault();
  elements.accountPasswordResult.textContent = "";
  elements.accountPasswordResult.classList.remove("is-success");
  elements.accountPasswordSubmit.disabled = true;
  elements.accountPasswordSubmit.textContent = "Alterando...";

  try {
    const response = await apiRequest("/api/account/password", {
      method: "PUT",
      body: JSON.stringify({
        currentPassword: elements.accountCurrentPassword.value,
        newPassword: elements.accountNewPassword.value,
        newPasswordConfirmation: elements.accountNewPasswordConfirmation.value,
      }),
    });
    applySessionPayload(response);
    closePasswordChangeModal();
    showToast("Senha alterada com sucesso.", "success");
  } catch (error) {
    elements.accountPasswordResult.textContent = error.message;
  } finally {
    elements.accountPasswordSubmit.disabled = false;
    elements.accountPasswordSubmit.textContent = "Alterar senha";
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
    state.archivedConversations = [];
    state.presence = [];
    state.handoffTargets = [];
    state.transferRequests = [];
    elements.requiredPasswordForm?.reset();
    elements.accountPasswordForm?.reset();
    elements.passwordChangeModal?.classList.remove("is-open");
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
    const canManageTransfers = hasPermission("transfer_requests:manage");
    const [
      conversationResult,
      agents,
      teams,
      inboxData,
      labelsData,
      presenceData,
      handoffData,
      transferData,
    ] = await Promise.all([
      fetchAllConversations(),
      apiRequest(`/api/v1/accounts/${state.accountId}/agents`).catch(() => []),
      apiRequest(`/api/v1/accounts/${state.accountId}/teams`).catch(() => []),
      apiRequest(`/api/v1/accounts/${state.accountId}/inboxes`).catch(() => ({ payload: [] })),
      apiRequest(`/api/v1/accounts/${state.accountId}/labels`).catch(() => ({ payload: [] })),
      apiRequest("/api/crm/presence").catch(() => ({ presence: [] })),
      apiRequest("/api/crm/handoff/targets").catch(() => ({ targets: [] })),
      canManageTransfers
        ? apiRequest("/api/crm/transfer-requests?status=pending").catch(() => ({ requests: [] }))
        : Promise.resolve({ requests: [] }),
    ]);

    const conversations = Array.isArray(conversationResult?.conversations)
      ? conversationResult.conversations
      : [];
    state.conversations = sortOperationalQueue(conversations);
    state.archivedConversations = Array.isArray(conversationResult?.archivedConversations)
      ? conversationResult.archivedConversations
      : [];
    state.interventionCount = Number(conversationResult?.interventionCount || 0);
    state.organizationConversationCount = Number(
      conversationResult?.totalOrganization || conversations.length
    );
    state.agents = Array.isArray(agents) ? agents : agents?.payload || [];
    state.teams = Array.isArray(teams) ? teams : teams?.payload || [];
    state.inboxes = Array.isArray(inboxData) ? inboxData : inboxData?.payload || [];
    state.labels = Array.isArray(labelsData) ? labelsData : labelsData?.payload || [];
    state.presence = Array.isArray(presenceData?.presence) ? presenceData.presence : [];
    state.handoffTargets = Array.isArray(handoffData?.targets) ? handoffData.targets : [];
    state.transferRequests = Array.isArray(transferData?.requests) ? transferData.requests : [];
    state.monthlySalesGoalProgress = conversationResult?.monthlySalesGoalProgress || {
      ...state.monthlySalesGoal,
      currentSales: 0,
      percentage: 0,
    };

    if (hasPermission("users:manage")) renderUsers();
    renderIdentity();
    renderPresence();
    renderTransferRequests();
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

function pipelineFilteredConversations() {
  return filteredConversations().filter((conversation) => {
    if (!isTerminalConversation(conversation)) return true;
    return matchesPeriod(
      conversation,
      state.pipelinePeriod,
      state.pipelinePeriodStart,
      state.pipelinePeriodEnd
    );
  });
}

function historyConversations() {
  return filteredConversations()
    .filter(isTerminalConversation)
    .filter((conversation) => state.historyType === "all" || getConversationStage(conversation) === state.historyType)
    .filter((conversation) => matchesPeriod(
      conversation,
      state.historyPeriod,
      state.historyPeriodStart,
      state.historyPeriodEnd
    ))
    .sort((a, b) => outcomeTimestamp(b) - outcomeTimestamp(a));
}

function archivedSearchResults() {
  const search = safeLower(state.search.trim());
  if (!search) return [...state.archivedConversations];
  return state.archivedConversations.filter((conversation) => {
    const sender = getSender(conversation);
    const archive = conversation.crm_archive || {};
    return [
      sender.name,
      sender.phone_number,
      sender.email,
      conversation.id,
      archive.reason,
      archive.note,
      getLastMessage(conversation),
    ].map(safeLower).join(" ").includes(search);
  });
}

function renderAll() {
  renderDashboard();
  renderInterventions();
  renderTransferRequests();
  renderPipeline();
  renderHistory();
  renderArchive();
  renderConversationsTable();
  renderTasks();
  renderContacts();
  renderTutorials();
  renderPresence();
  updateInterventionNavigation();
  updateArchiveNavigation();
  updateCreditNavigation();
}

function monthlyGoalMessage(progress) {
  if (progress.achieved) return "Meta alcançada! Agora é ampliar o resultado.";
  const percentage = Number(progress.percentage || 0);
  if (percentage >= 75) return "Reta final: falta pouco para bater a meta.";
  if (percentage >= 50) return "Metade do caminho concluída. Mantenham o ritmo.";
  if (percentage >= 25) return "A meta está ganhando ritmo.";
  return "Cada venda aproxima a equipe da meta do mês.";
}

function renderMonthlySalesGoal() {
  const card = elements.monthlySalesGoalCard;
  if (!card) return;
  const progress = state.monthlySalesGoalProgress || {};
  const enabled = progress.enabled === true && Number(progress.targetSales || 0) > 0;
  card.classList.toggle("is-hidden", !enabled);
  if (!enabled) return;
  const percentage = Math.max(0, Number(progress.percentage || 0));
  const visualPercentage = Math.min(100, percentage);
  elements.monthlySalesGoalTitle.textContent = `Meta mensal · ${state.organization?.name || "Loja"}`;
  elements.monthlySalesGoalPeriod.textContent = `Período: ${progress.periodStart || "—"} a ${progress.periodEnd || "—"}`;
  elements.monthlySalesGoalScore.textContent = `${Number(progress.currentSales || 0)} / ${Number(progress.targetSales || 0)}`;
  elements.monthlySalesGoalFill.style.width = `${visualPercentage}%`;
  elements.monthlySalesGoalFill.classList.toggle("is-achieved", progress.achieved === true);
  elements.monthlySalesGoalPercentage.textContent = `${percentage.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
  elements.monthlySalesGoalMessage.textContent = monthlyGoalMessage(progress);
  const track = elements.monthlySalesGoalFill.parentElement;
  track?.setAttribute("aria-valuenow", String(Math.min(100, Math.round(percentage))));
}

function renderMonthlyGoalSettings() {
  if (!elements.monthlyGoalEnabled || !elements.monthlyGoalTarget) return;
  const goal = state.monthlySalesGoal || { enabled: false, targetSales: 0 };
  elements.monthlyGoalEnabled.checked = goal.enabled === true;
  elements.monthlyGoalTarget.value = Number(goal.targetSales || 0) > 0 ? String(goal.targetSales) : "";
  elements.monthlyGoalTarget.disabled = !elements.monthlyGoalEnabled.checked;
}

async function saveMonthlyGoalSettings(event) {
  event.preventDefault();
  const enabled = elements.monthlyGoalEnabled.checked;
  const targetSales = Number(elements.monthlyGoalTarget.value || 0);
  elements.monthlyGoalSettingsResult.textContent = "Salvando meta mensal...";
  try {
    const response = await apiRequest("/api/crm/settings/monthly-sales-goal", {
      method: "PATCH",
      body: JSON.stringify({ enabled, targetSales }),
    });
    state.monthlySalesGoal = response.monthlySalesGoal || { enabled, targetSales };
    renderMonthlyGoalSettings();
    elements.monthlyGoalSettingsResult.textContent = enabled
      ? "Meta mensal ativada. O progresso aparecerá no Dashboard."
      : "Meta mensal desativada. A configuração foi preservada.";
    await loadWorkspace({ background: true, skipCentralReload: true });
    showToast(enabled ? "Meta mensal ativada." : "Meta mensal desativada.", "success");
  } catch (error) {
    elements.monthlyGoalSettingsResult.textContent = `Erro: ${error.message}`;
  }
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

  renderMonthlySalesGoal();
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
  const conversations = pipelineFilteredConversations();
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
    const currentLimit = Number(state.columnLimits[stage.id] || PIPELINE_COLUMN_PAGE_SIZE);
    const visibleConversations = stageConversations.slice(0, currentLimit);

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
    for (const conversation of visibleConversations) {
      list.appendChild(createOpportunityCard(conversation));
    }
    if (!stageConversations.length) {
      list.appendChild(createElement("div", "pipeline-empty", "Nenhuma oportunidade nesta etapa"));
    } else if (visibleConversations.length < stageConversations.length) {
      const more = createElement(
        "button",
        "pipeline-load-more",
        `Mostrar mais ${Math.min(PIPELINE_COLUMN_PAGE_SIZE, stageConversations.length - visibleConversations.length)}`
      );
      more.type = "button";
      more.addEventListener("click", () => {
        state.columnLimits[stage.id] = currentLimit + PIPELINE_COLUMN_PAGE_SIZE;
        renderPipeline();
      });
      list.appendChild(more);
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
    ["assignee", "👤", "Encaminhar atendimento"],
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
      if (action === "assignee") {
        openOpportunityDrawer(conversation.id);
        return window.setTimeout(() => openHandoffModal(conversation.id), 80);
      }
      if (action === "won" || action === "lost") {
        return requestStageTransition(conversation.id, action);
      }
      if (action === "chatwoot") return openInChatwootById(conversation.id);
    });
    quickActions.appendChild(button);
  }
  if (hasPermission("archive:manage")) {
    const archive = createElement("button", "card-quick-action action-archive", "⌑");
    archive.type = "button";
    archive.title = "Arquivar oportunidade";
    archive.addEventListener("mousedown", (event) => event.stopPropagation());
    archive.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openArchiveModal(conversation.id);
    });
    quickActions.appendChild(archive);
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
    const response = await updateCustomAttributes(conversationId, nextAttributes);
    conversation.custom_attributes = response?.effectiveCustomAttributes || nextAttributes;
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

function findConversationById(conversationId) {
  return [...state.conversations, ...state.archivedConversations].find(
    (conversation) => Number(conversation.id) === Number(conversationId)
  );
}

function drawerConversation() {
  return findConversationById(state.currentConversationId);
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
  const conversation = findConversationById(conversationId);
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
  const archived = Boolean(conversation.crm_archive);
  const canWrite = hasPermission("opportunities:write") && !archived;
  const canAssignDirectly = hasPermission("assignments:manage") && ["admin", "manager"].includes(state.user?.operationalRole);
  const canUseControlledHandoff = ["admin", "manager", "sdr", "seller"].includes(state.user?.operationalRole);
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
  elements.drawerAssignee.disabled = !canAssignDirectly;
  elements.drawerTeam.disabled = !canAssignDirectly;
  elements.drawerHandoffPanel?.classList.toggle("is-hidden", !canUseControlledHandoff);
  elements.openHandoff.disabled = !canUseControlledHandoff;
  elements.drawerHandoffHelper.textContent = ["admin", "manager"].includes(state.user?.operationalRole)
    ? "A gestão pode transferir para qualquer usuário operacional ativo."
    : state.user?.operationalRole === "sdr"
      ? "Encaminhe para um vendedor ou escale para a gestão."
      : "Devolva para a SDR, escale para a gestão ou solicite redistribuição.";
  elements.archiveOpportunity.classList.toggle("is-hidden", !hasPermission("archive:manage") || Boolean(conversation.crm_archive));
  elements.saveOpportunity.disabled = !canWrite;
  elements.replyContent.disabled = !hasPermission("messages:send") || archived;
  elements.replyPrivate.disabled = !hasPermission("messages:send") || archived;
  elements.replySubmit.disabled = !hasPermission("messages:send") || archived;
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
    elements.openHandoff.focus();
    elements.openHandoff.scrollIntoView({ behavior: "smooth", block: "center" });
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

    const attributeResponse = await updateCustomAttributes(conversationId, customAttributes);
    const effectiveCustomAttributes = attributeResponse?.effectiveCustomAttributes || customAttributes;

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
      ["admin", "manager"].includes(state.user?.operationalRole) &&
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

    conversation.custom_attributes = effectiveCustomAttributes;
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
  return {
    search: state.search,
    filters: { ...state.filters },
    pipelinePeriod: state.pipelinePeriod,
    pipelinePeriodStart: state.pipelinePeriodStart,
    pipelinePeriodEnd: state.pipelinePeriodEnd,
  };
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
  state.pipelinePeriod = preset.pipelinePeriod || "7d";
  state.pipelinePeriodStart = preset.pipelinePeriodStart || "";
  state.pipelinePeriodEnd = preset.pipelinePeriodEnd || "";
  elements.globalSearch.value = state.search;
  elements.filterAssignee.value = state.filters.assignee || "";
  elements.filterTeam.value = state.filters.team || "";
  elements.filterInbox.value = state.filters.inbox || "";
  elements.filterLabel.value = state.filters.label || "";
  elements.filterPriority.value = state.filters.priority || "";
  elements.filterTaskStatus.value = state.filters.taskStatus || "";
  elements.filterPeriod.value = state.pipelinePeriod;
  elements.filterPeriodStart.value = state.pipelinePeriodStart;
  elements.filterPeriodEnd.value = state.pipelinePeriodEnd;
  elements.customPeriodFields.classList.toggle("is-hidden", state.pipelinePeriod !== "custom");
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
  state.pipelinePeriod = preset.pipelinePeriod || "7d";
  state.pipelinePeriodStart = preset.pipelinePeriodStart || "";
  state.pipelinePeriodEnd = preset.pipelinePeriodEnd || "";
  elements.globalSearch.value = state.search;
  elements.filterAssignee.value = state.filters.assignee || "";
  elements.filterTeam.value = state.filters.team || "";
  elements.filterInbox.value = state.filters.inbox || "";
  elements.filterLabel.value = state.filters.label || "";
  elements.filterPriority.value = state.filters.priority || "";
  elements.filterTaskStatus.value = state.filters.taskStatus || "";
  elements.filterPeriod.value = state.pipelinePeriod;
  elements.filterPeriodStart.value = state.pipelinePeriodStart;
  elements.filterPeriodEnd.value = state.pipelinePeriodEnd;
  elements.customPeriodFields.classList.toggle("is-hidden", state.pipelinePeriod !== "custom");
  state.columnLimits = {};
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
    const presence = state.presence.find((item) => item.userId === user.id) || { status: "offline" };
    const title = createElement("strong", "crm-user-name-with-status");
    title.append(
      createElement("i", `presence-dot presence-${presence.status}`),
      document.createTextNode(user.name)
    );
    info.append(
      title,
      createElement(
        "span",
        null,
        `${user.email} · ${roleLabel(user.operationalRole || user.role)} · ${scopeLabel(user.visibilityScope, user.operationalRole || user.role)}`
      ),
      createElement(
        "small",
        user.chatwootAgentId ? "linked-agent-ok" : "linked-agent-warning",
        linkedAgent?.name || (user.chatwootAgentId ? `Agente #${user.chatwootAgentId}` : "Sem agente Chatwoot vinculado")
      ),
      createElement(
        "small",
        `user-presence-label presence-text-${presence.status}`,
        presence.lastSeenAt
          ? `${presenceStatusLabel(presence.status)} · última atividade ${formatRelativeTime(presence.lastSeenAt)} atrás`
          : "Offline · ainda não acessou nesta base"
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


function presenceStatusLabel(status) {
  return { online: "Online", away: "Ausente", offline: "Offline" }[status] || "Offline";
}

function renderPresence() {
  if (!elements.sidebarPresenceList) return;
  elements.sidebarPresenceList.replaceChildren();
  const order = { online: 0, away: 1, offline: 2 };
  const members = [...state.presence].sort((a, b) => {
    const statusDiff = (order[a.status] ?? 3) - (order[b.status] ?? 3);
    return statusDiff || String(a.name).localeCompare(String(b.name), "pt-BR");
  });
  if (!members.length) {
    elements.sidebarPresenceList.appendChild(createElement("span", "presence-empty", "Sem dados de presença"));
    return;
  }
  for (const member of members) {
    const row = createElement("div", "presence-row");
    const dot = createElement("i", `presence-dot presence-${member.status}`);
    const name = createElement("span", "presence-name", member.name);
    const status = createElement("small", null, presenceStatusLabel(member.status));
    row.title = member.lastSeenAt
      ? `${presenceStatusLabel(member.status)} · última atividade ${formatRelativeTime(member.lastSeenAt)} atrás`
      : "Ainda não acessou nesta base";
    row.append(dot, name, status);
    elements.sidebarPresenceList.appendChild(row);
  }
  const current = members.find((member) => member.userId === state.user?.id);
  if (elements.currentUserStatusDot) {
    elements.currentUserStatusDot.className = `status-dot presence-${current?.status || "online"}`;
  }
}

async function refreshPresence(options = {}) {
  try {
    const response = await apiRequest("/api/crm/presence");
    state.presence = Array.isArray(response?.presence) ? response.presence : [];
    renderPresence();
    if (!options.silent) showToast("Presença da equipe atualizada.", "success");
  } catch (error) {
    if (!options.silent) showToast(`Não foi possível atualizar a presença: ${error.message}`, "error");
  }
}

async function sendPresenceHeartbeat(action = false) {
  if (!state.user || elements.app.classList.contains("is-hidden")) return;
  try {
    await apiRequest("/api/crm/presence/heartbeat", {
      method: "POST",
      body: JSON.stringify({ view: state.currentView, action }),
    });
  } catch (_error) {
    // O heartbeat nunca deve interromper a operação do CRM.
  }
}

function updateArchiveNavigation() {
  const canManage = hasPermission("archive:manage");
  elements.archiveNavItem?.classList.toggle("is-hidden", !canManage);
}

function updateCreditNavigation() {
  const allowed = hasPermission("credit:monitor");
  elements.creditNavItem?.classList.toggle("is-hidden", !allowed);
}

const CREDIT_STATUS_LABELS = {
  queued: "Na fila",
  processing: "Em análise",
  waiting_input: "Aguardando informação",
  ready: "Pronto para análise",
  available: "Oportunidade encontrada",
  completed: "Concluído",
  blocked: "Bloqueado",
  attention_required: "Exige atenção",
  failed: "Falha",
  unavailable: "Sem oportunidade",
};

const CREDIT_ACTION_LABELS = {
  collect_cpf: "Coletar CPF",
  collect_birth_date: "Coletar data de nascimento",
  collect_phone: "Coletar telefone",
  collect_email: "Coletar e-mail",
  collect_cnh: "Coletar CNH",
  collect_down_payment: "Informar entrada",
  provide_missing_fields: "Solicitar informações pendentes",
  review: "Revisar análise",
  retry: "Aguardar nova tentativa",
};

const CREDIT_FIELD_LABELS = {
  cpf: "CPF",
  birth_date: "Data de nascimento",
  birthdate: "Data de nascimento",
  phone: "Telefone",
  email: "E-mail",
  cnh: "CNH",
  down_payment: "Entrada",
};

const CREDIT_PERIOD_PRESET_LABELS = {
  today: "Hoje",
  last7days: "Últimos 7 dias",
  currentMonth: "Mês atual",
  last30days: "Últimos 30 dias",
  currentYear: "Ano atual",
  custom: "Personalizado",
};

const CREDIT_BANK_NAMES_BY_CODE = {
  "033": "Santander",
  "336": "C6 Bank",
  "623": "Banco PAN",
};

function parseCreditPeriodDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  return date;
}

function getCreditPeriodWindow(preset, start = "", end = "", now = new Date()) {
  const reference = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (!Number.isFinite(reference.getTime()) || !Object.hasOwn(CREDIT_PERIOD_PRESET_LABELS, preset)) {
    return { valid: false, error: "Período inválido." };
  }

  const year = reference.getFullYear();
  const month = reference.getMonth();
  const day = reference.getDate();
  let from;
  let to = new Date(year, month, day + 1);

  if (preset === "custom") {
    if (!start || !end) return { valid: false, error: "Informe as datas inicial e final." };
    const startDate = parseCreditPeriodDate(start);
    const endDate = parseCreditPeriodDate(end);
    if (!startDate || !endDate) return { valid: false, error: "Informe datas válidas." };
    if (startDate.getTime() > endDate.getTime()) {
      return { valid: false, error: "A data inicial deve ser anterior ou igual à data final." };
    }
    from = startDate;
    to = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() + 1);
  } else if (preset === "today") {
    from = new Date(year, month, day);
  } else if (preset === "last7days") {
    from = new Date(year, month, day - 6);
  } else if (preset === "currentMonth") {
    from = new Date(year, month, 1);
  } else if (preset === "last30days") {
    from = new Date(year, month, day - 29);
  } else if (preset === "currentYear") {
    from = new Date(year, 0, 1);
  }

  return { valid: true, from: from.toISOString(), to: to.toISOString() };
}

function buildCreditOperationsUrl(periodWindow) {
  const query = new URLSearchParams({ from: periodWindow.from, to: periodWindow.to });
  return `/api/credit/operations?${query.toString()}`;
}

function formatCreditPeriodDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  return match ? `${match[3]}/${match[2]}/${match[1]}` : "";
}

function creditPeriodActiveLabel() {
  if (state.credit.periodPreset === "custom") {
    return `${formatCreditPeriodDate(state.credit.periodStart)} a ${formatCreditPeriodDate(state.credit.periodEnd)}`;
  }
  return CREDIT_PERIOD_PRESET_LABELS[state.credit.periodPreset] || CREDIT_PERIOD_PRESET_LABELS.today;
}

function setCreditPeriodFeedback(message = "") {
  if (!elements.creditPeriodFeedback) return;
  elements.creditPeriodFeedback.textContent = message;
  elements.creditPeriodFeedback.classList.toggle("is-hidden", !message);
}

function setCreditPeriodControlsDisabled(disabled) {
  for (const control of [
    elements.creditPeriodPreset,
    elements.creditPeriodStart,
    elements.creditPeriodEnd,
    elements.creditPeriodApply,
  ]) {
    if (control) control.disabled = disabled;
  }
}

function syncCreditPeriodControls() {
  if (elements.creditPeriodPreset) elements.creditPeriodPreset.value = state.credit.periodPreset;
  if (elements.creditPeriodStart) elements.creditPeriodStart.value = state.credit.periodStart;
  if (elements.creditPeriodEnd) elements.creditPeriodEnd.value = state.credit.periodEnd;
  elements.creditCustomPeriodFields?.classList.toggle("is-hidden", state.credit.periodPreset !== "custom");
}

function renderCreditPeriodState() {
  if (elements.creditPeriodActive) {
    elements.creditPeriodActive.textContent = `Período: ${creditPeriodActiveLabel()}`;
  }
  if (elements.creditMetricCpfLabel) {
    elements.creditMetricCpfLabel.textContent = state.credit.periodPreset === "today"
      ? "CPFs coletados hoje"
      : "CPFs coletados no período";
  }
  setCreditPeriodControlsDisabled(state.credit.loading);
}

async function handleCreditPeriodPresetChange() {
  const preset = elements.creditPeriodPreset.value;
  setCreditPeriodFeedback();
  elements.creditCustomPeriodFields?.classList.toggle("is-hidden", preset !== "custom");
  if (preset === "custom") return;
  await loadCreditOperations({ periodSelection: { preset, start: "", end: "" } });
}

async function handleCreditPeriodSubmit(event) {
  event.preventDefault();
  if (elements.creditPeriodPreset.value !== "custom") return;
  const periodSelection = {
    preset: "custom",
    start: elements.creditPeriodStart.value,
    end: elements.creditPeriodEnd.value,
  };
  const periodWindow = getCreditPeriodWindow(
    periodSelection.preset,
    periodSelection.start,
    periodSelection.end
  );
  if (!periodWindow.valid) {
    setCreditPeriodFeedback(periodWindow.error);
    return;
  }
  setCreditPeriodFeedback();
  await loadCreditOperations({ periodSelection, periodWindow });
}

function creditStatusLabel(status) {
  return CREDIT_STATUS_LABELS[status] || "Status não identificado";
}

function creditActionLabel(action) {
  if (!action) return "Nenhuma";
  return CREDIT_ACTION_LABELS[action] || "Ação pendente";
}

function creditDownPaymentLabel(downPayment) {
  if (downPayment?.known !== true) return "Não informada";
  if (downPayment.cents === 0) return "Sem entrada";
  return formatCurrency(Number(downPayment.cents || 0) / 100);
}

function creditAvailableLabel(value) {
  if (value === true) return "Sim";
  if (value === false) return "Não";
  return "Não informado";
}

function appendCreditDetailSection(title, entries) {
  const section = createElement("section", "drawer-section credit-detail-section");
  section.appendChild(createElement("h3", null, title));
  const list = createElement("dl", "credit-detail-list");
  for (const [label, value] of entries) {
    const row = createElement("div", "credit-detail-row");
    row.append(createElement("dt", null, label), createElement("dd", null, value ?? "—"));
    list.appendChild(row);
  }
  section.appendChild(list);
  elements.creditDetailBody.appendChild(section);
}

function creditCpfCountLabel(value) {
  const count = Math.max(1, Number(value) || 1);
  return `${count} CPF${count === 1 ? "" : "s"}`;
}

function appendCreditAttemptHistory(operation) {
  const attemptCount = Math.max(1, Number(operation?.applicantAttempt) || 1);
  const section = createElement("section", "drawer-section credit-detail-section");
  section.append(
    createElement("h3", null, "Histórico de CPFs na conversa"),
    createElement(
      "p",
      "muted credit-attempt-history-summary",
      `${creditCpfCountLabel(attemptCount)} analisado${attemptCount === 1 ? "" : "s"} nesta conversa.`
    )
  );
  const history = createElement("div", "credit-attempt-history");
  for (let attempt = attemptCount; attempt >= 1; attempt--) {
    const current = attempt === attemptCount;
    const item = createElement("article", `credit-attempt-item${current ? " is-current" : ""}`);
    const heading = createElement("div", "credit-attempt-item-heading");
    heading.append(
      createElement("strong", null, `Tentativa ${attempt}`),
      createElement("span", null, current ? "ATUAL" : "ANTERIOR")
    );
    item.appendChild(heading);
    if (current) {
      item.appendChild(createElement(
        "p",
        null,
        `${operation.cpfLast4 ? `CPF final ${operation.cpfLast4}` : "CPF protegido"} · ${creditStatusLabel(operation.status)}`
      ));
    } else {
      item.appendChild(createElement(
        "p",
        null,
        "CPF anterior contabilizado. Os detalhes não eram preservados pelo modelo legado."
      ));
    }
    history.appendChild(item);
  }
  section.appendChild(history);
  elements.creditDetailBody.appendChild(section);
}

function openCreditOperationDetail(operation) {
  if (!operation || !elements.creditOperationDrawer) return;
  elements.creditDetailConversation.textContent = `CONVERSA #${operation.conversationId}`;
  elements.creditDetailTitle.textContent = "Operação de crédito";
  elements.creditDetailMeta.textContent = `${creditStatusLabel(operation.status)} · ${creditCpfCountLabel(operation.applicantAttempt)} nesta conversa`;
  elements.creditDetailBody.replaceChildren();

  appendCreditDetailSection("Identificação", [
    ["Conversa", operation.conversationId],
    ["CPFs analisados", creditCpfCountLabel(operation.applicantAttempt)],
    ["Status", creditStatusLabel(operation.status)],
    ["Final do CPF", operation.cpfLast4 ? `Final ${operation.cpfLast4}` : "Não informado"],
  ]);
  appendCreditAttemptHistory(operation);
  const facts = operation.facts || {};
  appendCreditDetailSection("Dados coletados", [
    ["CPF presente", facts.cpfPresent ? "Sim" : "Não"],
    ["Nascimento presente", facts.birthDatePresent ? "Sim" : "Não"],
    ["Telefone presente", facts.phonePresent ? "Sim" : "Não"],
    ["E-mail presente", facts.emailPresent ? "Sim" : "Não"],
    ["CNH presente", facts.cnhPresent ? "Sim" : "Não"],
    ["Entrada", creditDownPaymentLabel(facts.downPayment)],
  ]);
  appendCreditDetailSection("Estado", [
    ["State UUID", operation.stateUuid || "—"],
    ["Revisão", operation.revision || 0],
    ["Criado em", formatDate(operation.createdAt)],
    ["Atualizado em", formatDate(operation.updatedAt)],
  ]);

  const banksSection = createElement("section", "drawer-section credit-detail-section");
  banksSection.appendChild(createElement("h3", null, "Bancos"));
  const banks = Array.isArray(operation.banks) ? operation.banks : [];
  if (!banks.length) {
    banksSection.appendChild(createElement("p", "muted", "Nenhum banco informado."));
  } else {
    const bankList = createElement("div", "credit-bank-detail-list");
    for (const bank of banks) {
      const card = createElement("article", "credit-bank-detail");
      card.appendChild(createElement("strong", null, creditBankLabel(bank)));
      const missingFields = Array.isArray(bank.missingFields) && bank.missingFields.length
        ? bank.missingFields.map((field) => CREDIT_FIELD_LABELS[field] || "Campo pendente").join(", ")
        : "Nenhum";
      const details = createElement("dl", "credit-detail-list");
      for (const [label, value] of [
        ["Status", creditStatusLabel(bank.status)],
        ["Disponível", creditAvailableLabel(bank.available)],
        ["Campos pendentes", missingFields],
      ]) {
        const row = createElement("div", "credit-detail-row");
        row.append(createElement("dt", null, label), createElement("dd", null, value));
        details.appendChild(row);
      }
      card.appendChild(details);
      bankList.appendChild(card);
    }
    banksSection.appendChild(bankList);
  }
  elements.creditDetailBody.appendChild(banksSection);

  const job = operation.job;
  appendCreditDetailSection("Job", job ? [
    ["Tipo", job.type],
    ["Status", creditStatusLabel(job.status)],
    ["Tentativas", `${job.attempts}/${job.maxAttempts}`],
    ["Atualizado em", formatDate(job.updatedAt)],
  ] : [["Situação", "Não informado"]]);
  appendCreditDetailSection("Próxima ação", [["Ação", creditActionLabel(operation.nextAction)]]);

  elements.creditOperationDrawer.classList.add("is-open");
  elements.creditOperationDrawer.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeCreditOperationDetail() {
  elements.creditOperationDrawer?.classList.remove("is-open");
  elements.creditOperationDrawer?.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

function creditAvailableBanks(operation) {
  return Array.isArray(operation?.banks)
    ? operation.banks.filter((bank) => bank?.available === true)
    : [];
}

function creditOperationHasOpportunity(operation) {
  return creditAvailableBanks(operation).length > 0;
}

function creditBankLabel(bank) {
  const code = String(bank?.code || "");
  const name = String(bank?.name || CREDIT_BANK_NAMES_BY_CODE[code] || "").trim();
  if (code && name) return `${code} · ${name}`;
  if (code) return `${code} · Banco não identificado`;
  return name || "Banco não identificado";
}

function getCreditOpportunityBankOptions(items) {
  const bankNamesByCode = new Map();
  for (const operation of Array.isArray(items) ? items : []) {
    for (const bank of Array.isArray(operation?.banks) ? operation.banks : []) {
      const code = String(bank?.code || "");
      if (code && bank?.name) bankNamesByCode.set(code, String(bank.name).trim());
    }
  }
  const banksByCode = new Map();
  for (const operation of Array.isArray(items) ? items : []) {
    const operationBankCodes = new Set();
    for (const bank of creditAvailableBanks(operation)) {
      const code = String(bank.code || "");
      if (!code || operationBankCodes.has(code)) continue;
      operationBankCodes.add(code);
      const bankWithResolvedName = { ...bank, name: bankNamesByCode.get(code) || bank.name };
      const current = banksByCode.get(code) || { code, label: creditBankLabel(bankWithResolvedName), count: 0 };
      current.count += 1;
      banksByCode.set(code, current);
    }
  }
  return [...banksByCode.values()].sort((left, right) => (
    right.count - left.count || left.code.localeCompare(right.code, "pt-BR", { numeric: true })
  ));
}

function filterCreditOperations(items, opportunityFilter = "all", bankFilter = "") {
  const operations = Array.isArray(items) ? items : [];
  if (bankFilter) {
    return operations.filter((operation) => (
      creditAvailableBanks(operation).some((bank) => String(bank.code || "") === bankFilter)
    ));
  }
  if (opportunityFilter === "available") return operations.filter(creditOperationHasOpportunity);
  return operations;
}

function selectCreditOpportunityFilter(filter) {
  state.credit.opportunityFilter = filter === "available" ? "available" : "all";
  state.credit.bankFilter = "";
  renderCreditOperations();
}

function selectCreditBankFilter(bankCode) {
  state.credit.opportunityFilter = "available";
  state.credit.bankFilter = String(bankCode || "");
  renderCreditOperations();
}

function creditQueueTotals(metrics, items) {
  const operations = Array.isArray(items) ? items : [];
  const source = metrics && typeof metrics === "object" ? metrics : {};
  const conversationCount = Object.hasOwn(source, "conversationCount")
    ? Math.max(0, Number(source.conversationCount) || 0)
    : operations.length;
  const cpfCount = Math.max(0, Number(source.cpfCollectedToday) || 0);
  return {
    conversationCount,
    cpfCount,
    additionalCpfCount: Math.max(0, cpfCount - conversationCount),
  };
}

function renderCreditQueueFilters() {
  const items = Array.isArray(state.credit.items) ? state.credit.items : [];
  const { conversationCount, cpfCount, additionalCpfCount } = creditQueueTotals(
    state.credit.metrics,
    items
  );
  const opportunityCount = items.filter(creditOperationHasOpportunity).length;
  const bankOptions = getCreditOpportunityBankOptions(items);
  if (state.credit.bankFilter && !bankOptions.some((bank) => bank.code === state.credit.bankFilter)) {
    state.credit.bankFilter = "";
  }
  const visibleItems = filterCreditOperations(
    items,
    state.credit.opportunityFilter,
    state.credit.bankFilter
  );

  if (elements.creditFilterAllCount) elements.creditFilterAllCount.textContent = String(conversationCount);
  if (elements.creditAdditionalCpfCount) {
    elements.creditAdditionalCpfCount.textContent = String(additionalCpfCount);
  }
  if (elements.creditFilterAvailableCount) {
    elements.creditFilterAvailableCount.textContent = String(opportunityCount);
  }
  document.querySelectorAll("[data-credit-opportunity-filter]").forEach((button) => {
    const active = button.dataset.creditOpportunityFilter === state.credit.opportunityFilter;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
    button.disabled = state.credit.loading;
  });

  if (elements.creditBankFilterGroup) {
    elements.creditBankFilterGroup.classList.toggle("is-hidden", bankOptions.length === 0);
  }
  if (elements.creditBankFilters) {
    elements.creditBankFilters.replaceChildren();
    for (const bank of bankOptions) {
      const button = createElement("button", "credit-bank-filter");
      button.type = "button";
      button.disabled = state.credit.loading;
      button.classList.toggle("is-active", state.credit.bankFilter === bank.code);
      button.setAttribute("aria-pressed", String(state.credit.bankFilter === bank.code));
      button.title = `${bank.label}: ${bank.count} lead${bank.count === 1 ? "" : "s"} com oportunidade`;
      button.append(
        createElement("span", null, bank.label),
        createElement("strong", null, `${bank.count} lead${bank.count === 1 ? "" : "s"}`)
      );
      button.addEventListener("click", () => selectCreditBankFilter(bank.code));
      elements.creditBankFilters.appendChild(button);
    }
  }
  if (elements.creditFilterSummary) {
    const loadedPrefix = state.credit.opportunityFilter === "all" && !state.credit.bankFilter
      ? `Exibindo ${visibleItems.length} de ${conversationCount} conversas`
      : `Exibindo ${visibleItems.length} conversas filtradas`;
    elements.creditFilterSummary.textContent = `${loadedPrefix} · ${cpfCount} CPFs analisados · ${additionalCpfCount} adicionais`;
  }
  return visibleItems;
}

function renderCreditOperations() {
  renderCreditPeriodState();
  const metrics = state.credit.metrics || {};
  if (elements.creditMetricCpfCollectedToday) {
    elements.creditMetricCpfCollectedToday.textContent = String(Math.max(0, Number(metrics.cpfCollectedToday) || 0));
  }
  if (elements.creditMetricProcessing) {
    elements.creditMetricProcessing.textContent = String(Math.max(0, Number(metrics.processing) || 0));
  }
  if (elements.creditMetricWaitingInput) {
    elements.creditMetricWaitingInput.textContent = String(Math.max(0, Number(metrics.waitingInput) || 0));
  }
  if (elements.creditMetricAttentionRequired) {
    elements.creditMetricAttentionRequired.textContent = String(Math.max(0, Number(metrics.attentionRequired) || 0));
  }
  const visibleItems = renderCreditQueueFilters();
  if (!elements.creditOperationsList) return;
  elements.creditOperationsList.replaceChildren();
  if (state.credit.loading) {
    elements.creditOperationsList.className = "credit-empty-state credit-loading-state";
    elements.creditOperationsList.append(
      createElement("strong", null, "Carregando análises…"),
      createElement("span", null, "Consultando a central de crédito.")
    );
    return;
  }
  if (state.credit.error) {
    elements.creditOperationsList.className = "credit-empty-state credit-error-state";
    elements.creditOperationsList.appendChild(createElement("strong", null, "Não foi possível carregar a central de crédito."));
    return;
  }
  if (!state.credit.items.length) {
    elements.creditOperationsList.className = "credit-empty-state";
    elements.creditOperationsList.appendChild(createElement("strong", null, "Nenhuma análise disponível ainda."));
    return;
  }
  if (!visibleItems.length) {
    elements.creditOperationsList.className = "credit-empty-state";
    elements.creditOperationsList.append(
      createElement("strong", null, "Nenhuma oportunidade encontrada para este filtro."),
      createElement("span", null, "Selecione outro banco ou visualize todas as análises.")
    );
    return;
  }

  elements.creditOperationsList.className = "credit-operations-list";
  for (const operation of visibleItems) {
    const row = createElement("button", "credit-operation-row");
    row.type = "button";
    row.classList.toggle("has-credit-opportunity", creditOperationHasOpportunity(operation));
    row.setAttribute("aria-label", `Abrir detalhes da conversa ${operation.conversationId}`);
    const fields = [
      ["Conversa", `#${operation.conversationId}`],
      ["CPFs", creditCpfCountLabel(operation.applicantAttempt)],
      ["Status", creditStatusLabel(operation.status), `credit-status credit-status-${operation.status}`],
      ["CPF", operation.cpfLast4 ? `Final ${operation.cpfLast4}` : "Não informado"],
      ["Entrada", creditDownPaymentLabel(operation.facts?.downPayment)],
      ["Bancos", (operation.banks || []).length
        ? operation.banks.map((bank) => `${creditBankLabel(bank)}: ${creditStatusLabel(bank.status)}`).join(" · ")
        : "Nenhum"],
      ["Próxima ação", creditActionLabel(operation.nextAction)],
      ["Atualização", formatDate(operation.updatedAt)],
    ];
    for (const [label, value, className] of fields) {
      const field = createElement("span", "credit-operation-field");
      field.append(createElement("small", null, label), createElement("strong", className || null, value));
      row.appendChild(field);
    }
    row.addEventListener("click", () => openCreditOperationDetail(operation));
    elements.creditOperationsList.appendChild(row);
  }
}

async function loadCreditOperations(options = {}) {
  if (!hasPermission("credit:monitor") || state.credit.loading) return;
  const periodSelection = options.periodSelection || {
    preset: state.credit.periodPreset,
    start: state.credit.periodStart,
    end: state.credit.periodEnd,
  };
  const periodWindow = options.periodWindow || getCreditPeriodWindow(
    periodSelection.preset,
    periodSelection.start,
    periodSelection.end
  );
  if (!periodWindow.valid) {
    setCreditPeriodFeedback(periodWindow.error);
    syncCreditPeriodControls();
    return;
  }
  state.credit.loading = true;
  state.credit.error = false;
  renderCreditOperations();
  try {
    const response = await apiRequest(buildCreditOperationsUrl(periodWindow));
    state.credit = {
      ...state.credit,
      enabled: response?.enabled === true,
      readOnly: response?.readOnly !== false,
      periodPreset: periodSelection.preset,
      periodStart: periodSelection.preset === "custom" ? periodSelection.start : "",
      periodEnd: periodSelection.preset === "custom" ? periodSelection.end : "",
      metrics: response?.metrics || {},
      items: Array.isArray(response?.items) ? response.items : [],
      loading: false,
      error: false,
    };
    syncCreditPeriodControls();
    renderCreditOperations();
  } catch (_error) {
    state.credit.error = true;
    state.credit.items = [];
    syncCreditPeriodControls();
    if (!options.silent) showToast("Não foi possível carregar a central de crédito.", "error");
  } finally {
    state.credit.loading = false;
    renderCreditOperations();
  }
}

function renderHistory() {
  if (!elements.historyList) return;
  const conversations = historyConversations();
  elements.historyCount.textContent = String(conversations.length);
  elements.historyList.replaceChildren();
  if (!conversations.length) {
    elements.historyList.appendChild(createElement("div", "empty-state", "Nenhum resultado encontrado neste período."));
    return;
  }
  const visible = conversations.slice(0, state.historyLimit);
  for (const conversation of visible) {
    const sender = getSender(conversation);
    const attributes = getCustomAttributes(conversation);
    const stage = getConversationStage(conversation);
    const row = createElement("article", `history-result history-${stage}`);
    const info = createElement("div", "history-result-main");
    info.append(
      createElement("strong", null, sender.name || `Contato #${conversation.id}`),
      createElement("span", null, `${sender.phone_number || sender.email || "Sem contato"} · Conversa #${conversation.id}`),
      createElement("small", null, stage === "won"
        ? `Ganho em ${formatDate(outcomeTimestamp(conversation))}`
        : `Perdido em ${formatDate(outcomeTimestamp(conversation))}${attributes.crm_loss_reason ? ` · ${attributes.crm_loss_reason}` : ""}`)
    );
    const side = createElement("div", "history-result-side");
    side.append(
      createElement("span", `history-status history-status-${stage}`, stage === "won" ? "Ganho" : "Perdido"),
      createElement("strong", null, parseCurrency(attributes.crm_value) ? formatCurrency(parseCurrency(attributes.crm_value)) : "Sem valor")
    );
    const open = createElement("button", "button button-ghost button-small", "Abrir");
    open.type = "button";
    open.addEventListener("click", () => openOpportunityDrawer(conversation.id));
    side.appendChild(open);
    row.append(info, side);
    elements.historyList.appendChild(row);
  }
  if (visible.length < conversations.length) {
    const more = createElement(
      "button",
      "pipeline-load-more history-load-more",
      `Mostrar mais ${Math.min(PIPELINE_COLUMN_PAGE_SIZE, conversations.length - visible.length)}`
    );
    more.type = "button";
    more.addEventListener("click", () => {
      state.historyLimit += PIPELINE_COLUMN_PAGE_SIZE;
      renderHistory();
    });
    elements.historyList.appendChild(more);
  }
}

function renderArchive() {
  if (!elements.archiveList) return;
  const conversations = archivedSearchResults().sort((a, b) => {
    return Date.parse(b.crm_archive?.archivedAt || "") - Date.parse(a.crm_archive?.archivedAt || "");
  });
  elements.archiveCount.textContent = String(conversations.length);
  elements.archiveList.replaceChildren();
  if (!hasPermission("archive:manage")) {
    elements.archiveList.appendChild(createElement("div", "empty-state", "Seu perfil não possui acesso ao arquivo."));
    return;
  }
  if (!conversations.length) {
    elements.archiveList.appendChild(createElement("div", "empty-state", "Nenhuma oportunidade arquivada."));
    return;
  }
  const visible = conversations.slice(0, state.archiveLimit);
  for (const conversation of visible) {
    const sender = getSender(conversation);
    const archive = conversation.crm_archive || {};
    const isChatwootResolvedArchive = conversation.archiveSource === "chatwoot_resolved";
    const row = createElement("article", "archive-item");
    const info = createElement("div", "archive-item-info");
    info.append(
      createElement("strong", null, sender.name || `Contato #${conversation.id}`),
      createElement("span", null, `${sender.phone_number || sender.email || "Sem contato"} · #${conversation.id}`),
      createElement(
        "small",
        null,
        isChatwootResolvedArchive
          ? "Resolvida no Chatwoot"
          : `${archive.reason || "Sem motivo"} · arquivado por ${archive.archivedByName || "Sistema"} em ${formatDate(archive.archivedAt)}`
      )
    );
    if (!isChatwootResolvedArchive && archive.note) {
      info.appendChild(createElement("p", null, archive.note));
    }
    const actions = createElement("div", "archive-item-actions");
    const open = createElement("button", "button button-ghost button-small", "Ver histórico");
    open.type = "button";
    open.addEventListener("click", () => openOpportunityDrawer(conversation.id));
    actions.appendChild(open);
    if (!isChatwootResolvedArchive) {
      const restore = createElement("button", "button button-primary button-small", "Restaurar");
      restore.type = "button";
      restore.addEventListener("click", () => restoreOpportunity(conversation.id));
      actions.appendChild(restore);
    }
    row.append(info, actions);
    elements.archiveList.appendChild(row);
  }
  if (visible.length < conversations.length) {
    const more = createElement(
      "button",
      "pipeline-load-more archive-load-more",
      `Mostrar mais ${Math.min(PIPELINE_COLUMN_PAGE_SIZE, conversations.length - visible.length)}`
    );
    more.type = "button";
    more.addEventListener("click", () => {
      state.archiveLimit += PIPELINE_COLUMN_PAGE_SIZE;
      renderArchive();
    });
    elements.archiveList.appendChild(more);
  }
}

function archiveScopeForReason(reason) {
  return ["Lead de teste", "Cadastro incorreto", "Sem valor operacional"].includes(
    String(reason || "").trim()
  )
    ? "contact"
    : "conversation";
}

function updateArchiveScopeHint() {
  if (!elements.archiveScopeHint || !elements.archiveReason) return;
  const scope = archiveScopeForReason(elements.archiveReason.value);
  elements.archiveScopeHint.textContent = scope === "contact"
    ? "Este motivo retira também outras conversas do mesmo contato da área de trabalho. O histórico continua preservado."
    : "Este motivo arquiva somente esta conversa. Outras conversas do mesmo contato continuam disponíveis.";
}

function openArchiveModal(conversationId = state.currentConversationId) {
  if (!hasPermission("archive:manage")) return;
  const conversation = findConversationById(conversationId);
  if (!conversation || conversation.crm_archive) return;
  state.pendingArchiveConversationId = Number(conversationId);
  const sender = getSender(conversation);
  elements.archiveDescription.textContent = `${sender.name || `Conversa #${conversation.id}`} · #${conversation.id}. O histórico continuará disponível.`;
  elements.archiveReason.value = "";
  elements.archiveNote.value = "";
  updateArchiveScopeHint();
  elements.archiveModal.classList.add("is-open");
  elements.archiveModal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeArchiveModal() {
  elements.archiveModal.classList.remove("is-open");
  elements.archiveModal.setAttribute("aria-hidden", "true");
  state.pendingArchiveConversationId = null;
  if (!elements.drawer.classList.contains("is-open")) document.body.style.overflow = "";
}

async function submitArchive(event) {
  event.preventDefault();
  const conversationId = state.pendingArchiveConversationId;
  const reason = elements.archiveReason.value;
  const note = elements.archiveNote.value.trim();
  const scope = archiveScopeForReason(reason);
  if (!conversationId || !reason) {
    showToast("Selecione o motivo do arquivamento.", "error");
    return;
  }
  if (reason === "Outro" && note.length < 3) {
    showToast("Descreva o motivo do arquivamento no campo de observação.", "error");
    elements.archiveNote.focus();
    return;
  }
  elements.archiveConfirm.disabled = true;
  try {
    await apiRequest(`/api/crm/opportunities/${conversationId}/archive`, {
      method: "POST",
      body: JSON.stringify({ reason, note, scope }),
    });
    closeArchiveModal();
    if (state.currentConversationId === conversationId) closeOpportunityDrawer();
    showToast(
      scope === "contact"
        ? "Lead arquivado. Outras conversas do mesmo contato também saíram da área de trabalho."
        : "Oportunidade arquivada com histórico preservado.",
      "success"
    );
    await loadWorkspace({ background: true });
  } catch (error) {
    showToast(`Não foi possível arquivar: ${error.message}`, "error");
  } finally {
    elements.archiveConfirm.disabled = false;
  }
}

async function restoreOpportunity(conversationId) {
  const confirmed = window.confirm("Restaurar esta oportunidade para o Pipeline ativo?");
  if (!confirmed) return;
  try {
    await apiRequest(`/api/crm/opportunities/${conversationId}/restore`, { method: "POST" });
    showToast("Oportunidade restaurada.", "success");
    await loadWorkspace({ background: true });
  } catch (error) {
    showToast(`Não foi possível restaurar: ${error.message}`, "error");
  }
}

function handoffActionsForRole(role) {
  if (["admin", "manager"].includes(role)) {
    return [{ id: "transfer", label: "Transferir para outro responsável" }];
  }
  if (role === "sdr") {
    return [
      { id: "to_seller", label: "Encaminhar para vendedor" },
      { id: "to_manager", label: "Escalar para gerente" },
    ];
  }
  if (role === "seller") {
    return [
      { id: "return_to_sdr", label: "Devolver para SDR" },
      { id: "to_manager", label: "Escalar para gerente" },
      { id: "request_redistribution", label: "Solicitar redistribuição" },
    ];
  }
  return [];
}

function handoffTargetsForAction(action) {
  if (action === "to_seller") return state.handoffTargets.filter((target) => target.operationalRole === "seller");
  if (action === "return_to_sdr") return state.handoffTargets.filter((target) => target.operationalRole === "sdr");
  if (action === "to_manager") return state.handoffTargets.filter((target) => ["manager", "admin"].includes(target.operationalRole));
  return state.handoffTargets;
}

function renderHandoffTargetOptions() {
  const action = elements.handoffAction.value;
  const requiresTarget = action !== "request_redistribution";
  elements.handoffTargetField.classList.toggle("is-hidden", !requiresTarget);
  elements.handoffTarget.required = requiresTarget;
  elements.handoffTarget.replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = requiresTarget ? "Selecione o destino" : "Gestão definirá o destino";
  elements.handoffTarget.appendChild(empty);
  for (const target of handoffTargetsForAction(action)) {
    const option = document.createElement("option");
    option.value = String(target.chatwootAgentId);
    option.textContent = `${target.name} · ${roleLabel(target.operationalRole)}`;
    elements.handoffTarget.appendChild(option);
  }
}

function openHandoffModal(conversationId = state.currentConversationId) {
  const actions = handoffActionsForRole(state.user?.operationalRole);
  if (!actions.length) {
    showToast("Seu perfil não possui opções de encaminhamento.", "error");
    return;
  }
  const conversation = findConversationById(conversationId);
  if (!conversation || conversation.crm_archive) return;
  state.pendingHandoffConversationId = Number(conversationId);
  const sender = getSender(conversation);
  elements.handoffDescription.textContent = `${sender.name || `Conversa #${conversation.id}`} · #${conversation.id}`;
  elements.handoffAction.replaceChildren();
  for (const action of actions) {
    const option = document.createElement("option");
    option.value = action.id;
    option.textContent = action.label;
    elements.handoffAction.appendChild(option);
  }
  elements.handoffReasonSelect.value = "";
  elements.handoffReasonDetail.value = "";
  elements.handoffReasonDetailField.classList.add("is-hidden");
  renderHandoffTargetOptions();
  elements.handoffModal.classList.add("is-open");
  elements.handoffModal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeHandoffModal() {
  elements.handoffModal.classList.remove("is-open");
  elements.handoffModal.setAttribute("aria-hidden", "true");
  state.pendingHandoffConversationId = null;
  if (!elements.drawer.classList.contains("is-open")) document.body.style.overflow = "";
}

async function submitHandoff(event) {
  event.preventDefault();
  const conversationId = state.pendingHandoffConversationId;
  const action = elements.handoffAction.value;
  const targetAgentId = elements.handoffTarget.value ? Number(elements.handoffTarget.value) : null;
  const selectedReason = elements.handoffReasonSelect.value;
  const detail = elements.handoffReasonDetail.value.trim();
  const reason = selectedReason === "Outro" ? detail : selectedReason;
  if (!conversationId || !action || !reason || (action !== "request_redistribution" && !targetAgentId)) {
    showToast("Preencha a ação, o destino e o motivo.", "error");
    return;
  }
  elements.handoffConfirm.disabled = true;
  try {
    const result = await apiRequest(`/api/crm/opportunities/${conversationId}/handoff`, {
      method: "POST",
      body: JSON.stringify({ action, targetAgentId, reason }),
    });
    closeHandoffModal();
    if (result?.requested) {
      showToast("Solicitação de redistribuição enviada à gestão.", "success");
    } else {
      showToast("Encaminhamento concluído e registrado.", "success");
      if (state.currentConversationId === conversationId) closeOpportunityDrawer();
    }
    await loadWorkspace({ background: true });
  } catch (error) {
    showToast(`Não foi possível encaminhar: ${error.message}`, "error");
  } finally {
    elements.handoffConfirm.disabled = false;
  }
}

function renderTransferRequests() {
  if (!elements.transferRequestsPanel || !elements.transferRequestList) return;
  const canManage = hasPermission("transfer_requests:manage");
  elements.transferRequestsPanel.classList.toggle("is-hidden", !canManage);
  if (!canManage) return;
  elements.transferRequestCount.textContent = String(state.transferRequests.length);
  elements.transferRequestList.replaceChildren();
  if (!state.transferRequests.length) {
    elements.transferRequestList.appendChild(createElement("div", "empty-state", "Nenhuma solicitação pendente."));
    return;
  }
  for (const request of state.transferRequests) {
    const conversation = findConversationById(request.conversationId);
    const sender = getSender(conversation || {});
    const row = createElement("article", "transfer-request-item");
    const info = createElement("div", "transfer-request-info");
    info.append(
      createElement("strong", null, sender.name || `Conversa #${request.conversationId}`),
      createElement("span", null, `Solicitado por ${request.requesterName} · ${formatDate(request.createdAt)}`),
      createElement("small", null, request.reason)
    );
    const button = createElement("button", "button button-primary button-small", "Distribuir");
    button.type = "button";
    button.addEventListener("click", () => openRedistributionModal(request.id));
    row.append(info, button);
    elements.transferRequestList.appendChild(row);
  }
}

function openRedistributionModal(requestId) {
  const request = state.transferRequests.find((item) => item.id === requestId);
  if (!request) return;
  state.pendingRedistributionRequestId = requestId;
  elements.redistributionDescription.textContent = `Conversa #${request.conversationId} · ${request.requesterName}: ${request.reason}`;
  elements.redistributionTarget.replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "Selecione o novo responsável";
  elements.redistributionTarget.appendChild(empty);
  for (const target of state.handoffTargets) {
    const option = document.createElement("option");
    option.value = String(target.chatwootAgentId);
    option.textContent = `${target.name} · ${roleLabel(target.operationalRole)}`;
    elements.redistributionTarget.appendChild(option);
  }
  elements.redistributionNote.value = "";
  elements.redistributionModal.classList.add("is-open");
  elements.redistributionModal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeRedistributionModal() {
  elements.redistributionModal.classList.remove("is-open");
  elements.redistributionModal.setAttribute("aria-hidden", "true");
  state.pendingRedistributionRequestId = null;
  document.body.style.overflow = "";
}

async function resolveRedistribution(decision) {
  const requestId = state.pendingRedistributionRequestId;
  const targetAgentId = Number(elements.redistributionTarget.value || 0);
  if (!requestId) return;
  if (decision === "approved" && !targetAgentId) {
    showToast("Selecione o novo responsável.", "error");
    return;
  }
  elements.redistributionApprove.disabled = true;
  elements.redistributionReject.disabled = true;
  try {
    await apiRequest(`/api/crm/transfer-requests/${requestId}/resolve`, {
      method: "POST",
      body: JSON.stringify({
        decision,
        targetAgentId: decision === "approved" ? targetAgentId : null,
        resolutionNote: elements.redistributionNote.value.trim(),
      }),
    });
    closeRedistributionModal();
    showToast(decision === "approved" ? "Redistribuição concluída." : "Solicitação rejeitada.", "success");
    await loadWorkspace({ background: true });
  } catch (error) {
    showToast(`Não foi possível resolver a solicitação: ${error.message}`, "error");
  } finally {
    elements.redistributionApprove.disabled = false;
    elements.redistributionReject.disabled = false;
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
    "opportunity.archived": "Arquivou uma oportunidade",
    "opportunity.restored": "Restaurou uma oportunidade",
    "handoff.completed": "Encaminhou uma oportunidade",
    "transfer.requested": "Solicitou redistribuição",
    "transfer.approved": "Aprovou redistribuição",
    "transfer.rejected": "Rejeitou redistribuição",
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

async function loadTutorials(options = {}) {
  if (state.tutorialLoading) return;
  state.tutorialLoading = true;
  try {
    const response = await apiRequest("/api/crm/tutorials");
    state.tutorials = Array.isArray(response?.tutorials) ? response.tutorials : [];
    if (!hasPermission("tutorials:manage") && state.tutorialTab === "manage") {
      state.tutorialTab = "watch";
    }
    renderTutorials();
  } catch (error) {
    if (!options.silent) showToast(`Erro ao carregar tutoriais: ${error.message}`, "error");
  } finally {
    state.tutorialLoading = false;
  }
}

function tutorialThumbnail(videoId) {
  return `https://i.ytimg.com/vi/${encodeURIComponent(String(videoId || ""))}/hqdefault.jpg`;
}

function renderTutorialTabs() {
  const manageAllowed = hasPermission("tutorials:manage");
  if (!manageAllowed && state.tutorialTab === "manage") state.tutorialTab = "watch";
  elements.tutorialWatchTab?.classList.toggle("is-active", state.tutorialTab === "watch");
  elements.tutorialManageTab?.classList.toggle("is-active", state.tutorialTab === "manage");
  elements.tutorialWatchPanel?.classList.toggle("is-active", state.tutorialTab === "watch");
  elements.tutorialManagePanel?.classList.toggle("is-active", state.tutorialTab === "manage" && manageAllowed);
}

function switchTutorialTab(tab) {
  const requested = tab === "manage" ? "manage" : "watch";
  if (requested === "manage" && !hasPermission("tutorials:manage")) return;
  state.tutorialTab = requested;
  renderTutorialTabs();
}

function renderTutorialCategoryFilters(activeTutorials) {
  if (!elements.tutorialCategoryFilters) return;
  const categories = [...new Set(activeTutorials.map((item) => String(item.category || "Geral").trim() || "Geral"))]
    .sort((a, b) => a.localeCompare(b, "pt-BR"));
  const available = new Set(["all", ...categories]);
  if (!available.has(state.tutorialCategory)) state.tutorialCategory = "all";
  elements.tutorialCategoryFilters.replaceChildren();

  const addFilter = (value, label) => {
    const button = createElement(
      "button",
      `tutorial-category-button${state.tutorialCategory === value ? " is-active" : ""}`,
      label
    );
    button.type = "button";
    button.addEventListener("click", () => {
      state.tutorialCategory = value;
      renderTutorials();
    });
    elements.tutorialCategoryFilters.appendChild(button);
  };

  addFilter("all", `Todos (${activeTutorials.length})`);
  for (const category of categories) {
    const total = activeTutorials.filter((item) => (item.category || "Geral") === category).length;
    addFilter(category, `${category} (${total})`);
  }
}

function openTutorialPlayer(tutorial) {
  if (!tutorial?.youtubeVideoId || !elements.tutorialPlayerModal) return;
  elements.tutorialPlayerTitle.textContent = tutorial.title || "Tutorial";
  elements.tutorialPlayerDescription.textContent = tutorial.description || "";
  elements.tutorialPlayerDescription.classList.toggle("is-hidden", !tutorial.description);
  elements.tutorialPlayerIframe.src =
    `https://www.youtube-nocookie.com/embed/${encodeURIComponent(tutorial.youtubeVideoId)}?autoplay=1&rel=0`;
  elements.tutorialPlayerModal.classList.add("is-open");
  elements.tutorialPlayerModal.setAttribute("aria-hidden", "false");
}

function closeTutorialPlayer() {
  if (!elements.tutorialPlayerModal) return;
  elements.tutorialPlayerModal.classList.remove("is-open");
  elements.tutorialPlayerModal.setAttribute("aria-hidden", "true");
  elements.tutorialPlayerIframe.src = "about:blank";
}

function renderTutorialWatchGrid(activeTutorials) {
  if (!elements.tutorialVideoGrid) return;
  const filtered = state.tutorialCategory === "all"
    ? activeTutorials
    : activeTutorials.filter((item) => (item.category || "Geral") === state.tutorialCategory);
  elements.tutorialVideoGrid.replaceChildren();

  if (!filtered.length) {
    elements.tutorialVideoGrid.appendChild(
      createElement("div", "empty-state tutorial-empty", "Nenhum tutorial disponível nesta categoria.")
    );
    return;
  }

  for (const tutorial of filtered) {
    const card = createElement("article", "tutorial-video-card");
    const media = createElement("button", "tutorial-video-media");
    media.type = "button";
    media.title = `Assistir ${tutorial.title}`;
    const image = document.createElement("img");
    image.src = tutorialThumbnail(tutorial.youtubeVideoId);
    image.alt = `Miniatura: ${tutorial.title}`;
    image.loading = "lazy";
    const play = createElement("span", "tutorial-play-button", "▶");
    media.append(image, play);
    media.addEventListener("click", () => openTutorialPlayer(tutorial));

    const body = createElement("div", "tutorial-video-body");
    const title = createElement("h3", "tutorial-video-title", tutorial.title);
    const category = createElement("span", "tutorial-video-category", tutorial.category || "Geral");
    body.append(title, category);
    if (tutorial.description) {
      body.appendChild(createElement("p", "tutorial-video-description", tutorial.description));
    }
    card.append(media, body);
    elements.tutorialVideoGrid.appendChild(card);
  }
}

function resetTutorialForm() {
  if (!elements.tutorialForm) return;
  elements.tutorialForm.reset();
  elements.tutorialEditId.value = "";
  elements.tutorialCategory.value = "Geral";
  elements.tutorialOrder.value = "0";
  elements.tutorialActive.checked = true;
  elements.tutorialFormTitle.textContent = "Adicionar vídeo";
  elements.tutorialSubmit.textContent = "+ Adicionar vídeo";
  elements.tutorialCancelEdit.classList.add("is-hidden");
}

function editTutorial(tutorial) {
  if (!hasPermission("tutorials:manage")) return;
  switchTutorialTab("manage");
  elements.tutorialEditId.value = tutorial.id;
  elements.tutorialYoutubeUrl.value = tutorial.youtubeUrl || `https://www.youtube.com/watch?v=${tutorial.youtubeVideoId}`;
  elements.tutorialTitle.value = tutorial.title || "";
  elements.tutorialDescription.value = tutorial.description || "";
  elements.tutorialCategory.value = tutorial.category || "Geral";
  elements.tutorialOrder.value = String(tutorial.displayOrder ?? 0);
  elements.tutorialActive.checked = tutorial.active !== false;
  elements.tutorialFormTitle.textContent = "Editar vídeo";
  elements.tutorialSubmit.textContent = "Salvar alterações";
  elements.tutorialCancelEdit.classList.remove("is-hidden");
  elements.tutorialYoutubeUrl.focus();
  elements.tutorialManagePanel?.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function toggleTutorialActive(tutorial) {
  if (!hasPermission("tutorials:manage")) return;
  try {
    await apiRequest(`/api/crm/tutorials/${encodeURIComponent(tutorial.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        youtubeUrl: tutorial.youtubeUrl,
        title: tutorial.title,
        description: tutorial.description,
        category: tutorial.category,
        displayOrder: tutorial.displayOrder,
        active: !tutorial.active,
      }),
    });
    showToast(tutorial.active ? "Tutorial ocultado da equipe." : "Tutorial ativado para a equipe.", "success");
    await loadTutorials({ silent: true });
  } catch (error) {
    showToast(`Não foi possível alterar o tutorial: ${error.message}`, "error");
  }
}

async function deleteTutorial(tutorial) {
  if (!hasPermission("tutorials:manage")) return;
  if (!window.confirm(`Excluir o tutorial "${tutorial.title}"?`)) return;
  try {
    await apiRequest(`/api/crm/tutorials/${encodeURIComponent(tutorial.id)}`, { method: "DELETE" });
    if (elements.tutorialEditId.value === tutorial.id) resetTutorialForm();
    showToast("Tutorial excluído.", "success");
    await loadTutorials({ silent: true });
  } catch (error) {
    showToast(`Não foi possível excluir o tutorial: ${error.message}`, "error");
  }
}

function renderTutorialManageList() {
  if (!elements.tutorialManageList || !hasPermission("tutorials:manage")) return;
  elements.tutorialManageList.replaceChildren();
  elements.tutorialManageCount.textContent = String(state.tutorials.length);

  if (!state.tutorials.length) {
    elements.tutorialManageList.appendChild(
      createElement("div", "empty-state", "Nenhum vídeo cadastrado ainda.")
    );
    return;
  }

  for (const tutorial of state.tutorials) {
    const row = createElement("article", "tutorial-manage-row");
    const thumb = createElement("button", "tutorial-manage-thumb");
    thumb.type = "button";
    thumb.title = "Assistir vídeo";
    const image = document.createElement("img");
    image.src = tutorialThumbnail(tutorial.youtubeVideoId);
    image.alt = "";
    image.loading = "lazy";
    thumb.appendChild(image);
    thumb.addEventListener("click", () => openTutorialPlayer(tutorial));

    const info = createElement("div", "tutorial-manage-info");
    info.append(
      createElement("strong", "", tutorial.title),
      createElement("span", "muted", tutorial.description || "Sem descrição")
    );

    const category = createElement("span", "tutorial-video-category", tutorial.category || "Geral");
    const order = createElement("span", "tutorial-order-value", String(tutorial.displayOrder ?? 0));
    const status = createElement(
      "button",
      `tutorial-status-button ${tutorial.active ? "is-active" : "is-inactive"}`,
      tutorial.active ? "Ativo" : "Inativo"
    );
    status.type = "button";
    status.title = tutorial.active ? "Ocultar da equipe" : "Ativar para a equipe";
    status.addEventListener("click", () => toggleTutorialActive(tutorial));

    const actions = createElement("div", "tutorial-manage-actions");
    const preview = createElement("button", "icon-button", "◉");
    preview.type = "button";
    preview.title = "Visualizar";
    preview.addEventListener("click", () => openTutorialPlayer(tutorial));
    const edit = createElement("button", "icon-button", "✎");
    edit.type = "button";
    edit.title = "Editar";
    edit.addEventListener("click", () => editTutorial(tutorial));
    const remove = createElement("button", "icon-button tutorial-delete-button", "⌫");
    remove.type = "button";
    remove.title = "Excluir";
    remove.addEventListener("click", () => deleteTutorial(tutorial));
    actions.append(preview, edit, remove);

    row.append(thumb, info, category, order, status, actions);
    elements.tutorialManageList.appendChild(row);
  }
}

function renderTutorials() {
  if (!elements.tutorialVideoGrid) return;
  const activeTutorials = state.tutorials.filter((item) => item.active !== false);
  renderTutorialTabs();
  renderTutorialCategoryFilters(activeTutorials);
  renderTutorialWatchGrid(activeTutorials);
  if (hasPermission("tutorials:manage")) renderTutorialManageList();
}

async function saveTutorial(event) {
  event.preventDefault();
  if (!hasPermission("tutorials:manage")) return;
  const tutorialId = elements.tutorialEditId.value.trim();
  const payload = {
    youtubeUrl: elements.tutorialYoutubeUrl.value.trim(),
    title: elements.tutorialTitle.value.trim(),
    description: elements.tutorialDescription.value.trim(),
    category: elements.tutorialCategory.value.trim() || "Geral",
    displayOrder: Number(elements.tutorialOrder.value || 0),
    active: elements.tutorialActive.checked,
  };
  elements.tutorialSubmit.disabled = true;
  try {
    await apiRequest(
      tutorialId ? `/api/crm/tutorials/${encodeURIComponent(tutorialId)}` : "/api/crm/tutorials",
      { method: tutorialId ? "PATCH" : "POST", body: JSON.stringify(payload) }
    );
    showToast(tutorialId ? "Tutorial atualizado." : "Tutorial adicionado.", "success");
    resetTutorialForm();
    await loadTutorials({ silent: true });
  } catch (error) {
    showToast(`Não foi possível salvar o tutorial: ${error.message}`, "error");
  } finally {
    elements.tutorialSubmit.disabled = false;
  }
}


const REACTIVATION_LABEL_TITLES = {
  "aguardando-cpf-terceiro": "Aguardando CPF de terceiros",
  "fora-de-horario": "Fora do horário",
  "aguardando-retorno-cliente": "Aguardando retorno do cliente",
};

function normalizeReactivationLabel(value) {
  return safeLower(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function reactivationLabelTitle(label) {
  const normalized = normalizeReactivationLabel(label);
  return REACTIVATION_LABEL_TITLES[normalized] || String(label || normalized).replace(/-/g, " ");
}

function selectedReactivationLabels() {
  return [...document.querySelectorAll("[data-reactivation-label]:checked")]
    .map((input) => normalizeReactivationLabel(input.value))
    .filter(Boolean);
}

function clientHasReactivationBlock(conversation) {
  const blockLabel = state.reactivation.configuration?.blockLabel || "reativacao-unica-enviada";
  return getLabels(conversation).some(
    (label) => normalizeReactivationLabel(label) === normalizeReactivationLabel(blockLabel)
  );
}

function clientReactivationTerminal(conversation) {
  return ["won", "lost"].includes(getConversationStage(conversation));
}

function updateReactivationNavigation() {
  const allowed = hasPermission("reactivations:manage");
  elements.reactivationNavItem?.classList.toggle("is-hidden", !allowed);
  if (!allowed || !elements.reactivationNavCount) return;

  let count = Number(state.reactivation?.serverEligibleCount);
  if (!Number.isFinite(count)) {
    const eligibleLabels = new Set(
      state.reactivation.configuration?.eligibleLabels || Object.keys(REACTIVATION_LABEL_TITLES)
    );
    count = state.conversations.filter((conversation) => {
      if (clientReactivationTerminal(conversation) || clientHasReactivationBlock(conversation)) return false;
      return getLabels(conversation).some((label) => eligibleLabels.has(normalizeReactivationLabel(label)));
    }).length;
  }
  elements.reactivationNavCount.textContent = String(count);
  elements.reactivationNavCount.classList.toggle("is-hidden", count <= 0);
}

function defaultReactivationCampaignName() {
  const now = new Date();
  return `Reativação ${new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(now)}`;
}

function populateReactivationTemplates() {
  if (!elements.reactivationTemplate) return;
  const templates = state.reactivation.configuration?.templates || [];
  const current = elements.reactivationTemplate.value;
  elements.reactivationTemplate.replaceChildren();
  for (const template of templates) {
    const option = document.createElement("option");
    option.value = template.key;
    option.textContent = template.label;
    option.dataset.message = template.message;
    elements.reactivationTemplate.appendChild(option);
  }
  if (templates.length) {
    elements.reactivationTemplate.value = templates.some((item) => item.key === current)
      ? current
      : templates[0].key;
    if (!elements.reactivationMessage.value.trim()) {
      elements.reactivationMessage.value = templates.find(
        (item) => item.key === elements.reactivationTemplate.value
      )?.message || "";
    }
  }
}

function reactivationSelectionEntries() {
  return [...state.reactivation.selected.entries()].map(([conversationId, value]) => ({
    conversationId: Number(conversationId),
    sourceType: value?.sourceType === "manual" ? "manual" : "tag",
    sourceReason: value?.sourceType === "manual" ? String(value?.sourceReason || "").trim() : null,
  }));
}

function reactivationSelectionConversation(conversationId) {
  return state.conversations.find((item) => Number(item.id) === Number(conversationId)) || null;
}

function reactivationSelectionCandidate(conversationId) {
  return (state.reactivation.candidates || []).find(
    (item) => Number(item.conversationId) === Number(conversationId)
  ) || null;
}

function reactivationManualCandidate(conversationId) {
  return (state.reactivation.manualCandidates || []).find(
    (item) => Number(item.conversationId) === Number(conversationId)
  ) || null;
}

function reactivationSelectionPresentation(conversationId, selection) {
  const candidate = reactivationSelectionCandidate(conversationId);
  const manualCandidate = reactivationManualCandidate(conversationId);
  const conversation = reactivationSelectionConversation(conversationId);
  const sender = getSender(conversation);
  const name = candidate?.contactName || manualCandidate?.contactName || sender.name || `Contato #${conversationId}`;
  const phone = candidate?.phone || manualCandidate?.phone || manualCandidate?.email || sender.phone_number || sender.email || "";
  const matchedLabels = Array.isArray(candidate?.matchedLabels)
    ? candidate.matchedLabels
    : Array.isArray(manualCandidate?.matchedLabels)
      ? manualCandidate.matchedLabels
      : [];
  const sourceType = selection?.sourceType === "manual" ? "manual" : "tag";
  const sourceReason = sourceType === "manual" ? String(selection?.sourceReason || "").trim() : "";
  return { name, phone, matchedLabels, sourceType, sourceReason };
}

function removeReactivationSelection(conversationId) {
  state.reactivation.selected.delete(Number(conversationId));
  updateReactivationSelectionSummary();
  renderReactivationCandidates();
  renderReactivationManualSelected();
  renderReactivationManualResults();
}

function renderReactivationSelectedList() {
  if (!elements.reactivationSelectedPanel || !elements.reactivationSelectedList) return;
  const entries = [...state.reactivation.selected.entries()];
  elements.reactivationSelectedList.replaceChildren();
  elements.reactivationSelectedCount.textContent = String(entries.length);
  elements.reactivationSelectedPanel.classList.toggle("is-hidden", entries.length === 0);

  for (const [conversationId, selection] of entries) {
    const display = reactivationSelectionPresentation(conversationId, selection);
    const row = createElement("div", "reactivation-selected-row");
    const info = createElement("div", "reactivation-selected-info");
    info.append(
      createElement("strong", null, display.name),
      createElement("span", null, display.phone || `Conversa #${conversationId}`)
    );
    const source = createElement("div", "reactivation-selected-source");
    if (display.sourceType === "manual") {
      source.append(
        createElement("span", "reactivation-chip", "Inclusão manual"),
        createElement("small", null, display.sourceReason || "Motivo não informado")
      );
    } else {
      const labels = display.matchedLabels.length
        ? display.matchedLabels.map(reactivationLabelTitle).join(" · ")
        : "Selecionado por etiqueta";
      source.append(
        createElement("span", "reactivation-chip", "Por etiqueta"),
        createElement("small", null, labels)
      );
    }
    const remove = createElement("button", "button button-ghost button-small", "Remover");
    remove.type = "button";
    remove.addEventListener("click", () => removeReactivationSelection(conversationId));
    row.append(info, source, remove);
    elements.reactivationSelectedList.appendChild(row);
  }
}

function reactivationDisplayCandidates() {
  const serverCandidates = Array.isArray(state.reactivation.candidates) ? state.reactivation.candidates : [];
  const existingIds = new Set(serverCandidates.map((candidate) => Number(candidate.conversationId)));
  const manualCandidates = [];

  for (const [conversationId, selection] of state.reactivation.selected.entries()) {
    const id = Number(conversationId);
    if (selection?.sourceType !== "manual" || existingIds.has(id)) continue;

    const candidate = reactivationManualCandidate(id);
    if (!candidate) continue;
    manualCandidates.push({
      ...candidate,
      eligible: !candidate.hasBlockLabel && !candidate.terminal,
      blockReason: candidate.hasBlockLabel
        ? "Etiqueta de proteção 'reativacao-unica-enviada' já aplicada"
        : candidate.terminal
          ? "Conversa encerrada, ganha ou perdida"
          : null,
      sourceType: "manual",
      sourceReason: String(selection?.sourceReason || "").trim(),
    });
  }

  return [...manualCandidates, ...serverCandidates];
}

function updateReactivationSelectionSummary() {
  const count = state.reactivation.selected.size;
  if (elements.reactivationSelectionSummary) {
    elements.reactivationSelectionSummary.textContent = `${count} selecionado${count === 1 ? "" : "s"}`;
  }
  if (elements.reactivationComposeCount) elements.reactivationComposeCount.textContent = String(count);
  if (elements.reactivationReview) {
    elements.reactivationReview.disabled = count === 0 || !elements.reactivationMessage?.value.trim();
  }
  renderReactivationSelectedList();
}

function renderReactivationCandidates() {
  if (!elements.reactivationCandidatesTable) return;
  const candidates = reactivationDisplayCandidates();
  elements.reactivationCandidatesTable.replaceChildren();
  elements.reactivationCandidateCount.textContent = String(candidates.length);

  if (!candidates.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.appendChild(createElement("div", "empty-state", "Nenhum lead encontrado com esses filtros."));
    row.appendChild(cell);
    elements.reactivationCandidatesTable.appendChild(row);
  }

  for (const candidate of candidates) {
    const row = document.createElement("tr");
    row.className = candidate.eligible ? "" : "reactivation-row-blocked";

    const selectCell = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.disabled = !candidate.eligible;
    checkbox.checked = state.reactivation.selected.has(Number(candidate.conversationId));
    checkbox.setAttribute("aria-label", `Selecionar ${candidate.contactName}`);
    checkbox.addEventListener("change", () => {
      const id = Number(candidate.conversationId);
      if (checkbox.checked) {
        const existing = state.reactivation.selected.get(id);
        state.reactivation.selected.set(id, existing || { sourceType: "tag" });
      } else {
        state.reactivation.selected.delete(id);
      }
      updateReactivationSelectionSummary();
      renderReactivationCandidates();
    });
    selectCell.appendChild(checkbox);

    const contactCell = document.createElement("td");
    const contact = createElement("div", "reactivation-contact");
    contact.append(
      createElement("strong", null, candidate.contactName || `Contato #${candidate.conversationId}`),
      createElement("span", null, candidate.phone || candidate.email || `Conversa #${candidate.conversationId}`),
      createElement("small", null, `Conversa #${candidate.conversationId}`)
    );
    contactCell.appendChild(contact);

    const reasonCell = document.createElement("td");
    const chips = createElement("div", "reactivation-chips");
    if (candidate.sourceType === "manual") {
      chips.appendChild(createElement("span", "reactivation-chip", "Inclusão manual"));
      if (candidate.sourceReason) {
        chips.appendChild(createElement("small", "reactivation-source-reason", candidate.sourceReason));
      }
    } else {
      for (const label of candidate.matchedLabels || []) {
        chips.appendChild(createElement("span", "reactivation-chip", reactivationLabelTitle(label)));
      }
    }
    reasonCell.appendChild(chips);

    const activityCell = createElement("td", null, candidate.lastActivityAt ? formatRelativeTime(candidate.lastActivityAt) : "—");
    activityCell.title = candidate.lastActivityAt ? formatDate(candidate.lastActivityAt) : "";

    const statusCell = document.createElement("td");
    statusCell.appendChild(
      createElement(
        "span",
        `reactivation-status ${candidate.eligible ? "is-eligible" : "is-blocked"}`,
        candidate.eligible ? "Elegível" : "Bloqueado"
      )
    );
    if (candidate.blockReason) statusCell.appendChild(createElement("small", "reactivation-block-reason", candidate.blockReason));

    const actionCell = document.createElement("td");
    const open = createElement("button", "button button-ghost button-small", "Abrir");
    open.type = "button";
    open.addEventListener("click", () => openOpportunityDrawer(candidate.conversationId));
    actionCell.appendChild(open);

    row.append(selectCell, contactCell, reasonCell, activityCell, statusCell, actionCell);
    elements.reactivationCandidatesTable.appendChild(row);
  }

  const blocked = candidates.filter((item) => !item.eligible).length;
  if (elements.reactivationBlockedSummary) {
    elements.reactivationBlockedSummary.textContent = blocked
      ? `${blocked} lead${blocked === 1 ? "" : "s"} encontrado${blocked === 1 ? "" : "s"} já está${blocked === 1 ? "" : "ão"} protegido${blocked === 1 ? "" : "s"} contra nova reativação.`
      : "Nenhum bloqueio encontrado neste filtro.";
  }
  updateReactivationSelectionSummary();
}

function renderReactivationMetrics() {
  const summary = state.reactivation.summary || {};
  if (elements.reactivationMetricEligible) {
    elements.reactivationMetricEligible.textContent = String(state.reactivation.serverEligibleCount || 0);
  }
  if (elements.reactivationMetricSent) elements.reactivationMetricSent.textContent = String(summary.sent || 0);
  if (elements.reactivationMetricReplied) elements.reactivationMetricReplied.textContent = String(summary.replied || 0);
  if (elements.reactivationMetricRate) elements.reactivationMetricRate.textContent = `${Number(summary.responseRate || 0).toFixed(1)}%`;
  updateReactivationNavigation();
}

function reactivationCampaignStatusLabel(status) {
  return {
    queued: "Na fila",
    running: "Enviando",
    completed: "Concluída",
    partial_failed: "Concluída com revisão",
    cancelled: "Cancelada",
  }[status] || status || "—";
}

async function loadReactivationCampaignRecipients(campaign, container, button) {
  if (container.dataset.loaded === "1") {
    container.classList.toggle("is-hidden");
    button.textContent = container.classList.contains("is-hidden") ? "Ver detalhes" : "Ocultar detalhes";
    return;
  }
  button.disabled = true;
  try {
    const response = await apiRequest(`/api/crm/reactivations/campaigns/${campaign.id}/recipients`);
    container.replaceChildren();
    for (const recipient of response.recipients || []) {
      const row = createElement("div", "reactivation-recipient-row");
      const info = createElement("div");
      info.append(
        createElement("strong", null, recipient.contactName),
        createElement("span", null, `Conversa #${recipient.conversationId} · ${recipient.sourceType === "manual" ? "inclusão manual" : "por etiqueta"}`)
      );
      if (recipient.sourceType === "manual" && recipient.sourceReason) {
        info.appendChild(createElement("small", null, `Motivo: ${recipient.sourceReason}`));
      }
      const status = createElement("div", "reactivation-recipient-status");
      status.appendChild(createElement("strong", null, recipient.status));
      if (recipient.repliedAt) status.appendChild(createElement("small", null, "Cliente respondeu"));
      else if (recipient.blockReason || recipient.lastError) {
        status.appendChild(createElement("small", null, recipient.blockReason || recipient.lastError));
      }
      const open = createElement("button", "button button-ghost button-small", "Abrir");
      open.type = "button";
      open.addEventListener("click", () => openOpportunityDrawer(recipient.conversationId));
      row.append(info, status, open);
      container.appendChild(row);
    }
    if (!(response.recipients || []).length) {
      container.appendChild(createElement("div", "empty-state", "Sem destinatários registrados."));
    }
    container.dataset.loaded = "1";
    container.classList.remove("is-hidden");
    button.textContent = "Ocultar detalhes";
  } catch (error) {
    showToast(`Não foi possível carregar os destinatários: ${error.message}`, "error");
  } finally {
    button.disabled = false;
  }
}

function renderReactivationHistory() {
  if (!elements.reactivationHistory) return;
  elements.reactivationHistory.replaceChildren();
  const campaigns = state.reactivation.campaigns || [];
  if (!campaigns.length) {
    elements.reactivationHistory.appendChild(
      createElement("div", "empty-state", "Nenhuma campanha de reativação registrada ainda.")
    );
    return;
  }

  for (const campaign of campaigns) {
    const card = createElement("article", "reactivation-history-card");
    const main = createElement("div", "reactivation-history-main");
    main.append(
      createElement("strong", null, campaign.name),
      createElement("span", null, `${formatDate(campaign.createdAt)} · ${campaign.creatorName}`),
      createElement("small", null, `Modelo: ${campaign.templateKey}`)
    );
    const metrics = createElement("div", "reactivation-history-metrics");
    const values = [
      ["Enviados", campaign.counts?.sent || 0],
      ["Responderam", campaign.counts?.replied || 0],
      ["Bloqueados", campaign.counts?.blocked || 0],
      ["Falhas", (campaign.counts?.failed || 0) + (campaign.counts?.uncertain || 0)],
    ];
    for (const [label, value] of values) {
      const metric = createElement("span");
      metric.append(createElement("small", null, label), createElement("strong", null, value));
      metrics.appendChild(metric);
    }
    const controls = createElement("div", "reactivation-history-controls");
    controls.appendChild(
      createElement(
        "span",
        `reactivation-status status-${campaign.status}`,
        reactivationCampaignStatusLabel(campaign.status)
      )
    );
    const detailsButton = createElement("button", "button button-ghost button-small", "Ver detalhes");
    detailsButton.type = "button";
    const details = createElement("div", "reactivation-recipient-list is-hidden");
    detailsButton.addEventListener("click", () => loadReactivationCampaignRecipients(campaign, details, detailsButton));
    controls.appendChild(detailsButton);
    if (["queued", "running"].includes(campaign.status)) {
      const cancel = createElement("button", "button button-danger button-small", "Cancelar pendentes");
      cancel.type = "button";
      cancel.addEventListener("click", async () => {
        if (!window.confirm("Cancelar os envios que ainda não saíram desta campanha?")) return;
        cancel.disabled = true;
        try {
          await apiRequest(`/api/crm/reactivations/campaigns/${campaign.id}/cancel`, { method: "POST" });
          showToast("Envios pendentes cancelados.", "success");
          await loadReactivationCenter({ silent: true });
        } catch (error) {
          showToast(`Não foi possível cancelar: ${error.message}`, "error");
        } finally {
          cancel.disabled = false;
        }
      });
      controls.appendChild(cancel);
    }
    card.append(main, metrics, controls, details);
    elements.reactivationHistory.appendChild(card);
  }
}

function renderReactivationCenter() {
  const config = state.reactivation.configuration;
  if (!config) return;
  if (elements.reactivationStoreName) {
    elements.reactivationStoreName.value = config.organizationName || state.organization?.name || "Loja atual";
  }
  if (elements.reactivationDisabledBanner) {
    elements.reactivationDisabledBanner.classList.toggle("is-hidden", Boolean(config.sendEnabled));
  }
  populateReactivationTemplates();
  renderReactivationCandidates();
  renderReactivationMetrics();
  renderReactivationHistory();
  if (elements.reactivationConfirm) elements.reactivationConfirm.disabled = !config.sendEnabled;
}

async function loadReactivationCenter(options = {}) {
  if (!hasPermission("reactivations:manage") || state.reactivation.loading) return;
  state.reactivation.loading = true;
  if (elements.reactivationRefresh) elements.reactivationRefresh.disabled = true;
  try {
    const labels = selectedReactivationLabels();
    const params = new URLSearchParams({
      period: state.reactivation.period || "7d",
      labels: labels.join(","),
      search: state.reactivation.search || "",
    });
    const [candidateResponse, campaignResponse] = await Promise.all([
      apiRequest(`/api/crm/reactivations/candidates?${params.toString()}`),
      apiRequest("/api/crm/reactivations/campaigns?sync=1&limit=30"),
    ]);
    state.reactivation.configuration = candidateResponse.configuration || state.reactivation.configuration;
    state.reactivation.candidates = Array.isArray(candidateResponse.candidates) ? candidateResponse.candidates : [];
    state.reactivation.manualCandidates = Array.isArray(candidateResponse.manualCandidates)
      ? candidateResponse.manualCandidates
      : [];
    state.reactivation.serverEligibleCount = Number(candidateResponse.eligibleCount || 0);
    state.reactivation.campaigns = Array.isArray(campaignResponse.campaigns) ? campaignResponse.campaigns : [];
    state.reactivation.summary = campaignResponse.summary || state.reactivation.summary;
    renderReactivationCenter();
    if (!options.silent) showToast("Central de reativação atualizada.", "success");
  } catch (error) {
    showToast(`Não foi possível carregar a reativação: ${error.message}`, "error");
  } finally {
    state.reactivation.loading = false;
    if (elements.reactivationRefresh) elements.reactivationRefresh.disabled = false;
  }
}

function selectAllEligibleReactivation() {
  for (const candidate of state.reactivation.candidates || []) {
    if (!candidate.eligible) continue;
    const id = Number(candidate.conversationId);
    if (!state.reactivation.selected.has(id)) state.reactivation.selected.set(id, { sourceType: "tag" });
  }
  renderReactivationCandidates();
}

function clearReactivationSelection() {
  state.reactivation.selected.clear();
  renderReactivationCandidates();
  renderReactivationManualSelected();
  renderReactivationManualResults();
}

function openReactivationManualModal() {
  elements.reactivationManualModal?.classList.add("is-open");
  elements.reactivationManualModal?.setAttribute("aria-hidden", "false");
  if (elements.reactivationManualSearch) {
    elements.reactivationManualSearch.value = "";
  }
  renderReactivationManualReasonState();
  renderReactivationManualSelected();
  renderReactivationManualResults();
  elements.reactivationManualSearch?.focus();
}

function closeReactivationManualModal() {
  elements.reactivationManualModal?.classList.remove("is-open");
  elements.reactivationManualModal?.setAttribute("aria-hidden", "true");
}

function renderReactivationManualReasonState() {
  const isOther = elements.reactivationManualReason?.value === "Outro";
  elements.reactivationManualReasonOtherWrap?.classList.toggle("is-hidden", !isOther);
  if (!isOther && elements.reactivationManualReasonOther) {
    elements.reactivationManualReasonOther.value = "";
  }
}

function currentReactivationManualReason() {
  const base = String(elements.reactivationManualReason?.value || "").trim();
  if (!base) return "";
  if (base !== "Outro") return base;
  return String(elements.reactivationManualReasonOther?.value || "").trim().replace(/\s+/g, " ").slice(0, 160);
}

function renderReactivationManualSelected() {
  if (!elements.reactivationManualSelectedPanel || !elements.reactivationManualSelectedList) return;
  const entries = [...state.reactivation.selected.entries()].filter(([, selection]) => selection?.sourceType === "manual");
  elements.reactivationManualSelectedList.replaceChildren();
  elements.reactivationManualSelectedCount.textContent = String(entries.length);
  elements.reactivationManualSelectedPanel.classList.toggle("is-hidden", entries.length === 0);

  for (const [conversationId, selection] of entries) {
    const display = reactivationSelectionPresentation(conversationId, selection);
    const row = createElement("div", "reactivation-manual-selected-row");
    const info = createElement("div");
    info.append(
      createElement("strong", null, display.name),
      createElement("span", null, display.phone || `Conversa #${conversationId}`),
      createElement("small", null, `Motivo: ${display.sourceReason || "—"}`)
    );
    const remove = createElement("button", "button button-ghost button-small", "Remover");
    remove.type = "button";
    remove.addEventListener("click", () => removeReactivationSelection(conversationId));
    row.append(info, remove);
    elements.reactivationManualSelectedList.appendChild(row);
  }
}

function renderReactivationManualResults() {
  if (!elements.reactivationManualResults) return;
  const query = safeLower(elements.reactivationManualSearch?.value || "");
  const candidates = (state.reactivation.manualCandidates || [])
    .filter((candidate) => {
      if (candidate.terminal) return false;
      const haystack = [candidate.contactName, candidate.phone, candidate.email, String(candidate.conversationId)]
        .join(" ")
        .toLocaleLowerCase("pt-BR");
      return !query || haystack.includes(query);
    })
    .slice(0, 40);
  elements.reactivationManualResults.replaceChildren();
  if (!candidates.length) {
    elements.reactivationManualResults.appendChild(createElement("div", "empty-state", "Nenhum contato ativo encontrado."));
    return;
  }
  for (const candidate of candidates) {
    const conversationId = Number(candidate.conversationId);
    const blocked = Boolean(candidate.hasBlockLabel);
    const selection = state.reactivation.selected.get(conversationId);
    const selectedByTag = selection?.sourceType === "tag";
    const selectedManually = selection?.sourceType === "manual";
    const row = createElement("div", `reactivation-manual-row${blocked ? " is-blocked" : ""}`);
    const info = createElement("div");
    info.append(
      createElement("strong", null, candidate.contactName || `Contato #${conversationId}`),
      createElement("span", null, candidate.phone || candidate.email || `Conversa #${conversationId}`),
      createElement(
        "small",
        null,
        blocked
          ? "Protegido pela etiqueta de reativação única"
          : selectedManually
            ? `Incluído manualmente · ${selection.sourceReason || "motivo não informado"}`
            : selectedByTag
              ? "Já selecionado pela lista de etiquetas"
              : `Conversa #${conversationId}`
      )
    );
    let button;
    if (selectedManually) {
      button = createElement("button", "button button-ghost button-small", "Remover");
      button.type = "button";
      button.addEventListener("click", () => removeReactivationSelection(conversationId));
    } else if (selectedByTag) {
      button = createElement("button", "button button-ghost button-small", "Selecionado por etiqueta");
      button.type = "button";
      button.disabled = true;
    } else {
      button = createElement("button", "button button-primary button-small", "Adicionar");
      button.type = "button";
      button.disabled = blocked;
      button.addEventListener("click", () => {
        const reason = currentReactivationManualReason();
        if (reason.length < 3) {
          showToast("Informe o motivo da inclusão manual antes de adicionar o contato.", "error");
          elements.reactivationManualReason?.focus();
          return;
        }
        state.reactivation.selected.set(conversationId, {
          sourceType: "manual",
          sourceReason: reason,
        });
        updateReactivationSelectionSummary();
        renderReactivationManualSelected();
        renderReactivationManualResults();
        renderReactivationCandidates();
      });
    }
    row.append(info, button);
    elements.reactivationManualResults.appendChild(row);
  }
}

function closeReactivationPreviewModal() {
  elements.reactivationPreviewModal?.classList.remove("is-open");
  elements.reactivationPreviewModal?.setAttribute("aria-hidden", "true");
}

function previewRenderedReactivationMessage() {
  const template = elements.reactivationMessage?.value.trim() || "";
  const firstSelection = reactivationSelectionEntries()[0];
  const conversation = state.conversations.find(
    (item) => Number(item.id) === Number(firstSelection?.conversationId)
  );
  const first = String(getSender(conversation)?.name || "tudo bem").trim().split(/\s+/)[0] || "tudo bem";
  return template.replace(/{{\s*primeiro_nome\s*}}/g, first);
}

function renderReactivationPreviewRecipients(selected) {
  if (!elements.reactivationPreviewRecipients) return;
  elements.reactivationPreviewRecipients.replaceChildren();
  for (const selection of selected) {
    const display = reactivationSelectionPresentation(selection.conversationId, selection);
    const row = createElement("div", "reactivation-preview-recipient-row");
    const info = createElement("div");
    info.append(
      createElement("strong", null, display.name),
      createElement("span", null, `Conversa #${selection.conversationId}`)
    );
    const origin = createElement("div", "reactivation-preview-recipient-origin");
    if (selection.sourceType === "manual") {
      origin.append(
        createElement("span", "reactivation-chip", "Inclusão manual"),
        createElement("small", null, selection.sourceReason || "Motivo não informado")
      );
    } else {
      origin.append(
        createElement("span", "reactivation-chip", "Por etiqueta"),
        createElement(
          "small",
          null,
          display.matchedLabels.length
            ? display.matchedLabels.map(reactivationLabelTitle).join(" · ")
            : "Etiqueta elegível"
        )
      );
    }
    row.append(info, origin);
    elements.reactivationPreviewRecipients.appendChild(row);
  }
}

function openReactivationPreview() {
  const selected = reactivationSelectionEntries();
  const message = elements.reactivationMessage?.value.trim() || "";
  if (!selected.length) {
    showToast("Selecione pelo menos um lead para reativar.", "error");
    return;
  }
  if (!message) {
    showToast("Escreva a mensagem da reativação.", "error");
    return;
  }
  const unsupported = [...message.matchAll(/{{\s*([^}]+?)\s*}}/g)]
    .map((match) => match[1])
    .filter((name) => name !== "primeiro_nome");
  if (unsupported.length) {
    showToast(`Variável não suportada: {{${unsupported[0]}}}`, "error");
    return;
  }
  for (const selection of selected) {
    if (selection.sourceType === "manual" && String(selection.sourceReason || "").trim().length < 3) {
      showToast(`Informe o motivo da inclusão manual da conversa #${selection.conversationId}.`, "error");
      return;
    }
  }
  let blocked = 0;
  for (const selection of selected) {
    const candidate = state.reactivation.candidates.find(
      (item) => Number(item.conversationId) === Number(selection.conversationId)
    );
    const conversation = state.conversations.find(
      (item) => Number(item.id) === Number(selection.conversationId)
    );
    const manualCandidate = reactivationManualCandidate(selection.conversationId);
    if (selection.sourceType === "tag" && candidate && !candidate.eligible) blocked += 1;
    else if (
      manualCandidate?.hasBlockLabel ||
      manualCandidate?.terminal ||
      clientHasReactivationBlock(conversation) ||
      clientReactivationTerminal(conversation)
    ) blocked += 1;
  }
  elements.reactivationPreviewSelected.textContent = String(selected.length);
  elements.reactivationPreviewBlocked.textContent = String(blocked);
  elements.reactivationPreviewEligible.textContent = String(Math.max(0, selected.length - blocked));
  renderReactivationPreviewRecipients(selected);
  elements.reactivationPreviewMessage.textContent = previewRenderedReactivationMessage();
  const sendEnabled = Boolean(state.reactivation.configuration?.sendEnabled);
  elements.reactivationPreviewWarning.classList.toggle("is-hidden", sendEnabled);
  elements.reactivationPreviewWarning.textContent = sendEnabled
    ? ""
    : "O envio continua desativado na implantação. A prévia funciona, mas a campanha só poderá ser criada após ativar REACTIVATION_SEND_ENABLED.";
  elements.reactivationConfirm.disabled = !sendEnabled;
  elements.reactivationPreviewModal.classList.add("is-open");
  elements.reactivationPreviewModal.setAttribute("aria-hidden", "false");
}

async function confirmReactivationCampaign() {
  const recipients = reactivationSelectionEntries();
  if (!recipients.length) return;
  elements.reactivationConfirm.disabled = true;
  try {
    const response = await apiRequest("/api/crm/reactivations/campaigns", {
      method: "POST",
      body: JSON.stringify({
        name: elements.reactivationCampaignName.value.trim() || defaultReactivationCampaignName(),
        templateKey: elements.reactivationTemplate.value || "custom",
        messageTemplate: elements.reactivationMessage.value.trim(),
        recipients,
      }),
    });
    closeReactivationPreviewModal();
    state.reactivation.selected.clear();
    const queued = Number(response.queued || 0);
    const blocked = Array.isArray(response.blocked) ? response.blocked.length : 0;
    showToast(
      blocked
        ? `Campanha criada: ${queued} na fila e ${blocked} bloqueado${blocked === 1 ? "" : "s"}.`
        : `Campanha criada com ${queued} envio${queued === 1 ? "" : "s"} na fila.`,
      queued > 0 ? "success" : "error"
    );
    elements.reactivationCampaignName.value = defaultReactivationCampaignName();
    await loadReactivationCenter({ silent: true });
  } catch (error) {
    showToast(`Não foi possível iniciar a reativação: ${error.message}`, "error");
  } finally {
    elements.reactivationConfirm.disabled = !state.reactivation.configuration?.sendEnabled;
  }
}

let reactivationSearchTimer = null;
function scheduleReactivationReload() {
  if (reactivationSearchTimer) window.clearTimeout(reactivationSearchTimer);
  reactivationSearchTimer = window.setTimeout(() => loadReactivationCenter({ silent: true }), 350);
}

function switchView(viewName) {
  if (viewName === "credit" && !hasPermission("credit:monitor")) return;
  state.currentView = viewName;
  document.querySelectorAll(".view").forEach((view) => view.classList.remove("is-active"));
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("is-active"));
  byId(`view-${viewName}`)?.classList.add("is-active");
  document.querySelector(`.nav-item[data-view="${viewName}"]`)?.classList.add("is-active");

  const titles = {
    dashboard: ["VISÃO GERAL", "Dashboard comercial"],
    interventions: ["AÇÃO IMEDIATA", "Intervenções humanas"],
    pipeline: ["OPORTUNIDADES", "Pipeline de vendas"],
    history: ["RESULTADOS", "Histórico encerrado"],
    archive: ["ORGANIZAÇÃO", "Oportunidades arquivadas"],
    conversations: ["ATENDIMENTO", "Conversas do Chatwoot"],
    reactivations: ["RECUPERAÇÃO CONTROLADA", "Reativação de leads"],
    tasks: ["PRODUTIVIDADE", "Tarefas comerciais"],
    contacts: ["RELACIONAMENTO", "Contatos"],
    tutorials: ["CENTRAL DE AJUDA", "Tutoriais"],
    credit: ["OPERAÇÃO DE CRÉDITO", "Central de crédito"],
    settings: ["ADMINISTRAÇÃO", "Configurações"],
  };
  const [eyebrow, title] = titles[viewName] || titles.dashboard;
  elements.pageEyebrow.textContent = eyebrow;
  elements.pageTitle.textContent = title;
  if (viewName === "tutorials") loadTutorials({ silent: true });
  if (viewName === "reactivations") loadReactivationCenter({ silent: true });
  if (viewName === "credit") loadCreditOperations();
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
  state.pipelinePeriod = "7d";
  state.pipelinePeriodStart = "";
  state.pipelinePeriodEnd = "";
  state.columnLimits = {};
  state.historyLimit = PIPELINE_COLUMN_PAGE_SIZE;
  state.archiveLimit = PIPELINE_COLUMN_PAGE_SIZE;
  elements.filterPeriod.value = "7d";
  elements.filterPeriodStart.value = "";
  elements.filterPeriodEnd.value = "";
  elements.customPeriodFields.classList.add("is-hidden");
  state.activeFilterPresetId = "";
  persistFilterPresets();
  renderFilterPresets();
  renderAll();
}

function configureAutoRefresh() {
  if (state.refreshTimer) window.clearInterval(state.refreshTimer);
  if (state.syncStatusTimer) window.clearInterval(state.syncStatusTimer);
  if (state.presenceTimer) window.clearInterval(state.presenceTimer);

  state.refreshTimer = window.setInterval(() => {
    if (
      elements.autoRefreshToggle?.checked &&
      !document.hidden &&
      !elements.app.classList.contains("is-hidden")
    ) {
      loadWorkspace({ background: true });
    }
  }, 60000);

  state.presenceTimer = window.setInterval(async () => {
    if (document.hidden || elements.app.classList.contains("is-hidden")) return;
    await sendPresenceHeartbeat(false);
    await refreshPresence({ silent: true });
  }, 60000);

  state.syncStatusTimer = window.setInterval(updateSyncStatus, 15000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) sendPresenceHeartbeat(false);
  });
}

function cacheElements() {
  Object.assign(elements, {
    loginScreen: byId("login-screen"),
    loginForm: byId("login-form"),
    loginEmail: byId("login-email"),
    loginPassword: byId("login-password"),
    loginSubmit: byId("login-submit"),
    loginError: byId("login-error"),
    passwordChangeScreen: byId("password-change-screen"),
    requiredPasswordForm: byId("required-password-form"),
    requiredNewPassword: byId("required-new-password"),
    requiredNewPasswordConfirmation: byId("required-new-password-confirmation"),
    requiredPasswordSubmit: byId("required-password-submit"),
    requiredPasswordLogout: byId("required-password-logout"),
    requiredPasswordError: byId("required-password-error"),
    app: byId("app"),
    sidebarAccountId: byId("sidebar-account-id"),
    sidebarUserName: byId("sidebar-user-name"),
    sidebarUserRole: byId("sidebar-user-role"),
    sidebarPresenceList: byId("sidebar-presence-list"),
    refreshPresence: byId("refresh-presence"),
    currentUserStatusDot: byId("current-user-status-dot"),
    archiveNavItem: byId("archive-nav-item"),
    creditNavItem: byId("credit-nav-item"),
    creditPeriodForm: byId("credit-period-form"),
    creditPeriodPreset: byId("credit-period-preset"),
    creditCustomPeriodFields: byId("credit-custom-period-fields"),
    creditPeriodStart: byId("credit-period-start"),
    creditPeriodEnd: byId("credit-period-end"),
    creditPeriodApply: byId("credit-period-apply"),
    creditPeriodFeedback: byId("credit-period-feedback"),
    creditPeriodActive: byId("credit-period-active"),
    creditMetricCpfLabel: byId("credit-metric-cpf-label"),
    creditFilterAllCount: byId("credit-filter-all-count"),
    creditAdditionalCpfCount: byId("credit-additional-cpf-count"),
    creditFilterAvailableCount: byId("credit-filter-available-count"),
    creditBankFilterGroup: byId("credit-bank-filter-group"),
    creditBankFilters: byId("credit-bank-filters"),
    creditFilterSummary: byId("credit-filter-summary"),
    creditMetricCpfCollectedToday: byId("credit-metric-cpf-collected-today"),
    creditMetricProcessing: byId("credit-metric-processing"),
    creditMetricWaitingInput: byId("credit-metric-waiting-input"),
    creditMetricAttentionRequired: byId("credit-metric-attention-required"),
    creditOperationsList: byId("credit-operations-list"),
    creditOperationDrawer: byId("credit-operation-drawer"),
    creditDetailConversation: byId("credit-detail-conversation"),
    creditDetailTitle: byId("credit-detail-title"),
    creditDetailMeta: byId("credit-detail-meta"),
    creditDetailBody: byId("credit-detail-body"),
    reactivationNavItem: byId("reactivation-nav-item"),
    reactivationNavCount: byId("reactivation-nav-count"),
    reactivationRefresh: byId("reactivation-refresh"),
    reactivationDisabledBanner: byId("reactivation-disabled-banner"),
    reactivationMetricEligible: byId("reactivation-metric-eligible"),
    reactivationMetricSent: byId("reactivation-metric-sent"),
    reactivationMetricReplied: byId("reactivation-metric-replied"),
    reactivationMetricRate: byId("reactivation-metric-rate"),
    reactivationStoreName: byId("reactivation-store-name"),
    reactivationPeriod: byId("reactivation-period"),
    reactivationSearch: byId("reactivation-search"),
    reactivationCandidateCount: byId("reactivation-candidate-count"),
    reactivationCandidatesTable: byId("reactivation-candidates-table"),
    reactivationBlockedSummary: byId("reactivation-blocked-summary"),
    reactivationSelectionSummary: byId("reactivation-selection-summary"),
    reactivationSelectAll: byId("reactivation-select-all"),
    reactivationClearSelection: byId("reactivation-clear-selection"),
    reactivationAddManual: byId("reactivation-add-manual"),
    reactivationCampaignName: byId("reactivation-campaign-name"),
    reactivationTemplate: byId("reactivation-template"),
    reactivationMessage: byId("reactivation-message"),
    reactivationComposeCount: byId("reactivation-compose-count"),
    reactivationReview: byId("reactivation-review"),
    reactivationHistory: byId("reactivation-history"),
    reactivationSelectedPanel: byId("reactivation-selected-panel"),
    reactivationSelectedCount: byId("reactivation-selected-count"),
    reactivationSelectedList: byId("reactivation-selected-list"),
    reactivationManualModal: byId("reactivation-manual-modal"),
    reactivationManualReason: byId("reactivation-manual-reason"),
    reactivationManualReasonOtherWrap: byId("reactivation-manual-reason-other-wrap"),
    reactivationManualReasonOther: byId("reactivation-manual-reason-other"),
    reactivationManualSelectedPanel: byId("reactivation-manual-selected-panel"),
    reactivationManualSelectedCount: byId("reactivation-manual-selected-count"),
    reactivationManualSelectedList: byId("reactivation-manual-selected-list"),
    reactivationManualSearch: byId("reactivation-manual-search"),
    reactivationManualResults: byId("reactivation-manual-results"),
    reactivationPreviewModal: byId("reactivation-preview-modal"),
    reactivationPreviewSelected: byId("reactivation-preview-selected"),
    reactivationPreviewRecipients: byId("reactivation-preview-recipients"),
    reactivationPreviewEligible: byId("reactivation-preview-eligible"),
    reactivationPreviewBlocked: byId("reactivation-preview-blocked"),
    reactivationPreviewMessage: byId("reactivation-preview-message"),
    reactivationPreviewWarning: byId("reactivation-preview-warning"),
    reactivationConfirm: byId("reactivation-confirm"),
    settingsAccountId: byId("settings-account-id"),
    settingsOrganizationName: byId("settings-organization-name"),
    settingsCurrentUser: byId("settings-current-user"),
    settingsCurrentScope: byId("settings-current-scope"),
    settingsLinkedAgent: byId("settings-linked-agent"),
    accountPasswordForm: byId("account-password-form"),
    accountCurrentPassword: byId("account-current-password"),
    accountNewPassword: byId("account-new-password"),
    accountNewPasswordConfirmation: byId("account-new-password-confirmation"),
    accountPasswordSubmit: byId("account-password-submit"),
    accountPasswordResult: byId("account-password-result"),
    passwordChangeModal: byId("password-change-modal"),
    pageEyebrow: byId("page-eyebrow"),
    pageTitle: byId("page-title"),
    globalSearch: byId("global-search"),
    refreshButton: byId("refresh-button"),
    lastSync: byId("last-sync"),
    autoRefreshToggle: byId("auto-refresh-toggle"),
    metricsGrid: byId("metrics-grid"),
    monthlySalesGoalCard: byId("monthly-sales-goal-card"),
    monthlySalesGoalTitle: byId("monthly-sales-goal-title"),
    monthlySalesGoalPeriod: byId("monthly-sales-goal-period"),
    monthlySalesGoalScore: byId("monthly-sales-goal-score"),
    monthlySalesGoalFill: byId("monthly-sales-goal-fill"),
    monthlySalesGoalMessage: byId("monthly-sales-goal-message"),
    monthlySalesGoalPercentage: byId("monthly-sales-goal-percentage"),
    interventionNavCount: byId("intervention-nav-count"),
    interventionViewCount: byId("intervention-view-count"),
    interventionList: byId("intervention-list"),
    transferRequestsPanel: byId("transfer-requests-panel"),
    transferRequestCount: byId("transfer-request-count"),
    transferRequestList: byId("transfer-request-list"),
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
    filterPeriod: byId("filter-period"),
    customPeriodFields: byId("custom-period-fields"),
    filterPeriodStart: byId("filter-period-start"),
    filterPeriodEnd: byId("filter-period-end"),
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
    tutorialWatchTab: byId("tutorial-watch-tab"),
    tutorialManageTab: byId("tutorial-manage-tab"),
    tutorialWatchPanel: byId("tutorial-watch-panel"),
    tutorialManagePanel: byId("tutorial-manage-panel"),
    tutorialCategoryFilters: byId("tutorial-category-filters"),
    tutorialVideoGrid: byId("tutorial-video-grid"),
    tutorialForm: byId("tutorial-form"),
    tutorialFormTitle: byId("tutorial-form-title"),
    tutorialEditId: byId("tutorial-edit-id"),
    tutorialYoutubeUrl: byId("tutorial-youtube-url"),
    tutorialTitle: byId("tutorial-title"),
    tutorialDescription: byId("tutorial-description"),
    tutorialCategory: byId("tutorial-category"),
    tutorialOrder: byId("tutorial-order"),
    tutorialActive: byId("tutorial-active"),
    tutorialSubmit: byId("tutorial-submit"),
    tutorialCancelEdit: byId("tutorial-cancel-edit"),
    tutorialManageCount: byId("tutorial-manage-count"),
    tutorialManageList: byId("tutorial-manage-list"),
    tutorialPlayerModal: byId("tutorial-player-modal"),
    tutorialPlayerIframe: byId("tutorial-player-iframe"),
    tutorialPlayerTitle: byId("tutorial-player-title"),
    tutorialPlayerDescription: byId("tutorial-player-description"),
    historyType: byId("history-type"),
    historyPeriod: byId("history-period"),
    historyCustomPeriodFields: byId("history-custom-period-fields"),
    historyPeriodStart: byId("history-period-start"),
    historyPeriodEnd: byId("history-period-end"),
    historyCount: byId("history-count"),
    historyList: byId("history-list"),
    archiveCount: byId("archive-count"),
    archiveList: byId("archive-list"),
    bootstrapCrm: byId("bootstrap-crm"),
    bootstrapResult: byId("bootstrap-result"),
    pipelineSettingsPanel: byId("pipeline-settings-panel"),
    monthlyGoalSettingsPanel: byId("monthly-goal-settings-panel"),
    monthlyGoalSettingsForm: byId("monthly-goal-settings-form"),
    monthlyGoalEnabled: byId("monthly-goal-enabled"),
    monthlyGoalTarget: byId("monthly-goal-target"),
    monthlyGoalSettingsResult: byId("monthly-goal-settings-result"),
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
    drawerHandoffPanel: byId("drawer-handoff-panel"),
    drawerHandoffHelper: byId("drawer-handoff-helper"),
    openHandoff: byId("open-handoff"),
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
    archiveOpportunity: byId("archive-opportunity"),
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
    handoffModal: byId("handoff-modal"),
    handoffForm: byId("handoff-form"),
    handoffDescription: byId("handoff-description"),
    handoffAction: byId("handoff-action"),
    handoffTargetField: byId("handoff-target-field"),
    handoffTarget: byId("handoff-target"),
    handoffReasonSelect: byId("handoff-reason-select"),
    handoffReasonDetailField: byId("handoff-reason-detail-field"),
    handoffReasonDetail: byId("handoff-reason-detail"),
    handoffConfirm: byId("handoff-confirm"),
    archiveModal: byId("archive-modal"),
    archiveForm: byId("archive-form"),
    archiveDescription: byId("archive-description"),
    archiveReason: byId("archive-reason"),
    archiveNote: byId("archive-note"),
    archiveScopeHint: byId("archive-scope-hint"),
    archiveConfirm: byId("archive-confirm"),
    redistributionModal: byId("redistribution-modal"),
    redistributionForm: byId("redistribution-form"),
    redistributionDescription: byId("redistribution-description"),
    redistributionTarget: byId("redistribution-target"),
    redistributionNote: byId("redistribution-note"),
    redistributionApprove: byId("redistribution-approve"),
    redistributionReject: byId("redistribution-reject"),
    loadingOverlay: byId("loading-overlay"),
    loadingMessage: byId("loading-message"),
    toastContainer: byId("toast-container"),
  });
}

function bindEvents() {
  elements.loginForm.addEventListener("submit", handleLogin);
  elements.requiredPasswordForm.addEventListener("submit", handleRequiredPasswordChange);
  elements.requiredPasswordLogout.addEventListener("click", logout);
  elements.accountPasswordForm.addEventListener("submit", handleVoluntaryPasswordChange);
  document.querySelectorAll("[data-open-password-change]").forEach((element) => {
    element.addEventListener("click", openPasswordChangeModal);
  });
  document.querySelectorAll("[data-close-password-change]").forEach((element) => {
    element.addEventListener("click", closePasswordChangeModal);
  });
  elements.logoutButton.addEventListener("click", logout);
  elements.refreshButton.addEventListener("click", () => loadWorkspace({ background: false }));
  elements.refreshPresence?.addEventListener("click", () => refreshPresence({ silent: false }));
  elements.bootstrapCrm.addEventListener("click", bootstrapCrm);
  elements.monthlyGoalSettingsForm?.addEventListener("submit", saveMonthlyGoalSettings);
  elements.monthlyGoalEnabled?.addEventListener("change", () => {
    elements.monthlyGoalTarget.disabled = !elements.monthlyGoalEnabled.checked;
  });
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
  elements.openHandoff?.addEventListener("click", () => openHandoffModal());
  elements.archiveOpportunity?.addEventListener("click", () => openArchiveModal());
  elements.handoffForm?.addEventListener("submit", submitHandoff);
  elements.handoffAction?.addEventListener("change", renderHandoffTargetOptions);
  elements.handoffReasonSelect?.addEventListener("change", () => {
    elements.handoffReasonDetailField.classList.toggle("is-hidden", elements.handoffReasonSelect.value !== "Outro");
  });
  document.querySelectorAll("[data-close-handoff]").forEach((element) => {
    element.addEventListener("click", closeHandoffModal);
  });
  elements.archiveForm?.addEventListener("submit", submitArchive);
  elements.archiveReason?.addEventListener("change", updateArchiveScopeHint);
  document.querySelectorAll("[data-close-archive]").forEach((element) => {
    element.addEventListener("click", closeArchiveModal);
  });
  elements.redistributionForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    resolveRedistribution("approved");
  });
  elements.redistributionReject?.addEventListener("click", () => resolveRedistribution("rejected"));
  document.querySelectorAll("[data-close-redistribution]").forEach((element) => {
    element.addEventListener("click", closeRedistributionModal);
  });
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
  elements.tutorialForm?.addEventListener("submit", saveTutorial);
  elements.tutorialCancelEdit?.addEventListener("click", resetTutorialForm);
  elements.reactivationRefresh?.addEventListener("click", () => loadReactivationCenter());
  elements.creditPeriodPreset?.addEventListener("change", handleCreditPeriodPresetChange);
  elements.creditPeriodForm?.addEventListener("submit", handleCreditPeriodSubmit);
  document.querySelectorAll("[data-credit-opportunity-filter]").forEach((button) => {
    button.addEventListener("click", () => selectCreditOpportunityFilter(button.dataset.creditOpportunityFilter));
  });
  elements.reactivationPeriod?.addEventListener("change", () => {
    state.reactivation.period = elements.reactivationPeriod.value;
    loadReactivationCenter({ silent: true });
  });
  document.querySelectorAll("[data-reactivation-label]").forEach((input) => {
    input.addEventListener("change", () => {
      if (!selectedReactivationLabels().length) {
        input.checked = true;
        showToast("Mantenha pelo menos uma etiqueta de elegibilidade selecionada.", "error");
        return;
      }
      loadReactivationCenter({ silent: true });
    });
  });
  elements.reactivationSearch?.addEventListener("input", () => {
    state.reactivation.search = elements.reactivationSearch.value.trim();
    scheduleReactivationReload();
  });
  elements.reactivationSelectAll?.addEventListener("click", selectAllEligibleReactivation);
  elements.reactivationClearSelection?.addEventListener("click", clearReactivationSelection);
  elements.reactivationAddManual?.addEventListener("click", openReactivationManualModal);
  elements.reactivationManualReason?.addEventListener("change", () => {
    renderReactivationManualReasonState();
    renderReactivationManualResults();
  });
  elements.reactivationManualReasonOther?.addEventListener("input", renderReactivationManualResults);
  elements.reactivationManualSearch?.addEventListener("input", renderReactivationManualResults);
  elements.reactivationTemplate?.addEventListener("change", () => {
    const template = state.reactivation.configuration?.templates?.find(
      (item) => item.key === elements.reactivationTemplate.value
    );
    if (template) elements.reactivationMessage.value = template.message;
    updateReactivationSelectionSummary();
  });
  elements.reactivationMessage?.addEventListener("input", updateReactivationSelectionSummary);
  elements.reactivationReview?.addEventListener("click", openReactivationPreview);
  elements.reactivationConfirm?.addEventListener("click", confirmReactivationCampaign);
  document.querySelectorAll("[data-close-reactivation-manual]").forEach((element) => {
    element.addEventListener("click", closeReactivationManualModal);
  });
  document.querySelectorAll("[data-close-reactivation-preview]").forEach((element) => {
    element.addEventListener("click", closeReactivationPreviewModal);
  });
  document.querySelectorAll("[data-tutorial-tab]").forEach((button) => {
    button.addEventListener("click", () => switchTutorialTab(button.dataset.tutorialTab));
  });
  document.querySelectorAll("[data-close-tutorial-player]").forEach((element) => {
    element.addEventListener("click", closeTutorialPlayer);
  });

  document.querySelectorAll("[data-close-drawer]").forEach((element) => {
    element.addEventListener("click", closeOpportunityDrawer);
  });
  document.querySelectorAll("[data-close-credit-detail]").forEach((element) => {
    element.addEventListener("click", closeCreditOperationDetail);
  });

  document.querySelectorAll(".nav-item[data-view]").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });

  document.querySelectorAll("[data-go-view]").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.goView));
  });

  elements.globalSearch.addEventListener("input", () => {
    state.search = elements.globalSearch.value;
    state.historyLimit = PIPELINE_COLUMN_PAGE_SIZE;
    state.archiveLimit = PIPELINE_COLUMN_PAGE_SIZE;
    state.columnLimits = {};
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
      state.historyLimit = PIPELINE_COLUMN_PAGE_SIZE;
      state.archiveLimit = PIPELINE_COLUMN_PAGE_SIZE;
      state.columnLimits = {};
      state.activeFilterPresetId = "";
      persistFilterPresets();
      renderFilterPresets();
      renderAll();
    });
  }

  elements.filterPeriod?.addEventListener("change", () => {
    state.pipelinePeriod = elements.filterPeriod.value;
    elements.customPeriodFields.classList.toggle("is-hidden", state.pipelinePeriod !== "custom");
    state.columnLimits = {};
    renderPipeline();
  });
  elements.filterPeriodStart?.addEventListener("change", () => {
    state.pipelinePeriodStart = elements.filterPeriodStart.value;
    state.columnLimits = {};
    renderPipeline();
  });
  elements.filterPeriodEnd?.addEventListener("change", () => {
    state.pipelinePeriodEnd = elements.filterPeriodEnd.value;
    state.columnLimits = {};
    renderPipeline();
  });
  elements.historyType?.addEventListener("change", () => {
    state.historyType = elements.historyType.value;
    state.historyLimit = PIPELINE_COLUMN_PAGE_SIZE;
    renderHistory();
  });
  elements.historyPeriod?.addEventListener("change", () => {
    state.historyPeriod = elements.historyPeriod.value;
    elements.historyCustomPeriodFields.classList.toggle("is-hidden", state.historyPeriod !== "custom");
    state.historyLimit = PIPELINE_COLUMN_PAGE_SIZE;
    renderHistory();
  });
  elements.historyPeriodStart?.addEventListener("change", () => {
    state.historyPeriodStart = elements.historyPeriodStart.value;
    state.historyLimit = PIPELINE_COLUMN_PAGE_SIZE;
    renderHistory();
  });
  elements.historyPeriodEnd?.addEventListener("change", () => {
    state.historyPeriodEnd = elements.historyPeriodEnd.value;
    state.historyLimit = PIPELINE_COLUMN_PAGE_SIZE;
    renderHistory();
  });

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
    if (elements.passwordChangeModal?.classList.contains("is-open")) {
      closePasswordChangeModal();
    } else if (elements.reactivationPreviewModal?.classList.contains("is-open")) {
      closeReactivationPreviewModal();
    } else if (elements.reactivationManualModal?.classList.contains("is-open")) {
      closeReactivationManualModal();
    } else if (elements.tutorialPlayerModal?.classList.contains("is-open")) {
      closeTutorialPlayer();
    } else if (elements.transitionModal.classList.contains("is-open")) {
      closeTransitionModal();
    } else if (elements.handoffModal?.classList.contains("is-open")) {
      closeHandoffModal();
    } else if (elements.archiveModal?.classList.contains("is-open")) {
      closeArchiveModal();
    } else if (elements.redistributionModal?.classList.contains("is-open")) {
      closeRedistributionModal();
    } else if (elements.drawer.classList.contains("is-open")) {
      closeOpportunityDrawer();
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  loadLocalConfiguration();
  cacheElements();
  if (elements.reactivationCampaignName) {
    elements.reactivationCampaignName.value = defaultReactivationCampaignName();
  }
  bindEvents();
  renderFilterPresets();
  renderStageManager();
  configureAutoRefresh();
  initializeSession();
});
