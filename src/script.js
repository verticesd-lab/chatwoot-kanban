const PIPELINE_STAGES = [
  { id: "new", label: "Novo lead", color: "#2563eb" },
  { id: "contacted", label: "Contato iniciado", color: "#0ea5e9" },
  { id: "qualification", label: "Qualificação", color: "#8b5cf6" },
  { id: "proposal", label: "Proposta", color: "#f59e0b" },
  { id: "negotiation", label: "Negociação", color: "#f97316" },
  { id: "won", label: "Ganho", color: "#10b981" },
  { id: "lost", label: "Perdido", color: "#ef4444" },
];

const PAGE_SIZE = 25;

const state = {
  accountId: null,
  conversations: [],
  agents: [],
  teams: [],
  inboxes: [],
  labels: [],
  currentView: "dashboard",
  currentConversationId: null,
  search: "",
  filters: {
    assignee: "",
    team: "",
    inbox: "",
    label: "",
  },
  draggingConversationId: null,
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

function getStage(stageId) {
  return PIPELINE_STAGES.find((stage) => stage.id === stageId) || PIPELINE_STAGES[0];
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

function getLabels(conversation) {
  const labels = conversation?.labels || conversation?.label_list || [];
  return Array.isArray(labels) ? labels : [];
}

function getCustomAttributes(conversation) {
  return conversation?.custom_attributes && typeof conversation.custom_attributes === "object"
    ? conversation.custom_attributes
    : {};
}

function getConversationStage(conversation) {
  const customStage = String(getCustomAttributes(conversation).crm_stage || "").trim();
  if (PIPELINE_STAGES.some((stage) => stage.id === customStage)) return customStage;

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
  const timestamp = getTimestamp(value);
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

async function initializeSession() {
  try {
    const session = await apiRequest("/api/session");
    if (session.connected) {
      state.accountId = Number(session.accountId);
      showApplication();
      await loadWorkspace();
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
  elements.sidebarAccountId.textContent = `Conta ${state.accountId}`;
  elements.settingsAccountId.textContent = String(state.accountId);
}

async function handleLogin(event) {
  event.preventDefault();
  elements.loginError.textContent = "";
  elements.loginSubmit.disabled = true;
  elements.loginSubmit.textContent = "Conectando...";

  try {
    const token = elements.loginToken.value.trim();
    const accountId = Number(elements.loginAccount.value);
    const response = await apiRequest("/api/session", {
      method: "POST",
      body: JSON.stringify({ token, accountId }),
    });
    state.accountId = Number(response.accountId);
    elements.loginToken.value = "";
    showApplication();
    await loadWorkspace();
  } catch (error) {
    elements.loginError.textContent = error.message;
  } finally {
    elements.loginSubmit.disabled = false;
    elements.loginSubmit.textContent = "Conectar ao Chatwoot";
  }
}

async function logout() {
  try {
    await apiRequest("/api/session", { method: "DELETE" });
  } finally {
    state.accountId = null;
    state.conversations = [];
    showLogin();
  }
}

async function fetchAllConversations() {
  const conversations = [];
  const seenIds = new Set();

  for (let page = 1; page <= 100; page += 1) {
    const data = await apiRequest(
      `/api/v1/accounts/${state.accountId}/conversations?status=all&assignee_type=all&page=${page}`
    );
    const payload = data?.data?.payload || data?.payload || data?.data || [];
    if (!Array.isArray(payload) || payload.length === 0) break;

    for (const conversation of payload) {
      if (!seenIds.has(conversation.id)) {
        seenIds.add(conversation.id);
        conversations.push(conversation);
      }
    }

    if (payload.length < PAGE_SIZE) break;
  }

  return conversations;
}

async function loadWorkspace() {
  setLoading(true, "Sincronizando conversas e equipe...");
  try {
    const [conversations, agents, teams, inboxData, labelsData] = await Promise.all([
      fetchAllConversations(),
      apiRequest(`/api/v1/accounts/${state.accountId}/agents`).catch(() => []),
      apiRequest(`/api/v1/accounts/${state.accountId}/teams`).catch(() => []),
      apiRequest(`/api/v1/accounts/${state.accountId}/inboxes`).catch(() => ({ payload: [] })),
      apiRequest(`/api/v1/accounts/${state.accountId}/labels`).catch(() => ({ payload: [] })),
    ]);

    state.conversations = conversations.sort(
      (a, b) => conversationActivityTimestamp(b) - conversationActivityTimestamp(a)
    );
    state.agents = Array.isArray(agents) ? agents : agents?.payload || [];
    state.teams = Array.isArray(teams) ? teams : teams?.payload || [];
    state.inboxes = Array.isArray(inboxData) ? inboxData : inboxData?.payload || [];
    state.labels = Array.isArray(labelsData) ? labelsData : labelsData?.payload || [];

    populateFilterOptions();
    populateDrawerOptions();
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
    setLoading(false);
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
  renderPipeline();
  renderConversationsTable();
  renderTasks();
  renderContacts();
}

function renderDashboard() {
  const conversations = filteredConversations();
  const openOpportunities = conversations.filter(
    (conversation) => !["won", "lost"].includes(getConversationStage(conversation))
  );
  const won = conversations.filter((conversation) => getConversationStage(conversation) === "won");
  const pendingTasks = conversations.filter((conversation) => {
    const attributes = getCustomAttributes(conversation);
    return attributes.crm_next_task && attributes.crm_task_done !== true && attributes.crm_task_done !== "true";
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
      help: `${conversations.length} conversas sincronizadas`,
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
    ...PIPELINE_STAGES.map(
      (stage) => conversations.filter((conversation) => getConversationStage(conversation) === stage.id).length
    )
  );

  for (const stage of PIPELINE_STAGES) {
    const stageConversations = conversations.filter(
      (conversation) => getConversationStage(conversation) === stage.id
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

function renderDashboardTasks(tasks) {
  elements.dashboardTasks.replaceChildren();
  const sortedTasks = [...tasks].sort((a, b) => {
    const aDate = getCustomAttributes(a).crm_task_due_at || "9999-12-31";
    const bDate = getCustomAttributes(b).crm_task_due_at || "9999-12-31";
    return aDate.localeCompare(bDate);
  });

  if (!sortedTasks.length) {
    elements.dashboardTasks.appendChild(createElement("div", "empty-state", "Nenhuma tarefa pendente."));
    return;
  }

  for (const conversation of sortedTasks.slice(0, 6)) {
    const sender = getSender(conversation);
    const attributes = getCustomAttributes(conversation);
    const item = createElement("div", "compact-item");
    const button = createElement("button");
    button.type = "button";
    button.append(
      createElement("strong", null, attributes.crm_next_task),
      createElement("span", null, sender.name || `Conversa #${conversation.id}`)
    );
    button.addEventListener("click", () => openOpportunityDrawer(conversation.id));
    const due = createElement(
      "span",
      `task-due ${isOverdue(attributes.crm_task_due_at) ? "overdue" : ""}`,
      attributes.crm_task_due_at ? formatDate(attributes.crm_task_due_at, { dateOnly: true }) : "Sem prazo"
    );
    item.append(button, due);
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

function renderPipeline() {
  const conversations = filteredConversations();
  elements.pipelineBoard.replaceChildren();

  for (const stage of PIPELINE_STAGES) {
    const stageConversations = conversations.filter(
      (conversation) => getConversationStage(conversation) === stage.id
    );
    const stageValue = stageConversations.reduce(
      (sum, conversation) => sum + parseCurrency(getCustomAttributes(conversation).crm_value),
      0
    );

    const column = createElement("section", "pipeline-column");
    column.dataset.stage = stage.id;
    const header = createElement("header", "pipeline-column-header");
    const title = createElement("div", "pipeline-title");
    const dot = createElement("span", "stage-dot");
    dot.style.background = stage.color;
    title.append(dot, createElement("strong", null, stage.label));
    header.append(
      title,
      createElement("span", null, `${stageConversations.length} · ${formatCurrency(stageValue)}`)
    );

    const list = createElement("div", "pipeline-list");
    list.dataset.stage = stage.id;
    for (const conversation of stageConversations) {
      list.appendChild(createOpportunityCard(conversation));
    }

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
      await moveOpportunity(conversationId, stage.id);
    });

    column.append(header, list);
    elements.pipelineBoard.appendChild(column);
  }
}

function createOpportunityCard(conversation) {
  const sender = getSender(conversation);
  const attributes = getCustomAttributes(conversation);
  const assignee = getAssignee(conversation);
  const labels = getLabels(conversation);
  const card = createElement("article", "opportunity-card");
  card.draggable = true;
  card.dataset.id = String(conversation.id);

  const top = createElement("div", "card-top");
  top.append(
    createElement("strong", null, sender.name || `Contato #${conversation.id}`),
    createElement("span", "card-meta", `#${conversation.id}`)
  );
  card.appendChild(top);
  card.appendChild(createElement("div", "card-phone", sender.phone_number || sender.email || "Sem contato"));
  card.appendChild(createElement("div", "card-message", getLastMessage(conversation)));

  const badges = createElement("div", "card-badges");
  if (conversation.priority && conversation.priority !== "none") {
    badges.appendChild(createElement("span", `badge ${conversation.priority}`, conversation.priority));
  }
  if (Number(conversation.unread_count || 0) > 0) {
    badges.appendChild(createElement("span", "badge unread", `${conversation.unread_count} não lida(s)`));
  }
  for (const label of labels.slice(0, 2)) badges.appendChild(createElement("span", "badge", label));
  card.appendChild(badges);

  const footer = createElement("div", "card-footer");
  const value = parseCurrency(attributes.crm_value);
  footer.append(
    createElement("span", "card-value", value ? formatCurrency(value) : assignee?.name || "Sem responsável"),
    createElement("span", "card-meta", formatRelativeTime(conversationActivityTimestamp(conversation)))
  );
  card.appendChild(footer);

  if (attributes.crm_next_task && attributes.crm_task_done !== true && attributes.crm_task_done !== "true") {
    const task = createElement(
      "div",
      `task-due ${isOverdue(attributes.crm_task_due_at) ? "overdue" : ""}`,
      `↳ ${attributes.crm_next_task}${attributes.crm_task_due_at ? ` · ${formatDate(attributes.crm_task_due_at, { dateOnly: true })}` : ""}`
    );
    task.style.marginTop = "8px";
    card.appendChild(task);
  }

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

async function moveOpportunity(conversationId, stageId) {
  const conversation = state.conversations.find((item) => Number(item.id) === Number(conversationId));
  if (!conversation || getConversationStage(conversation) === stageId) return;

  const previousAttributes = getCustomAttributes(conversation);
  conversation.custom_attributes = { ...previousAttributes, crm_stage: stageId };
  renderAll();

  try {
    await updateCustomAttributes(conversationId, conversation.custom_attributes);
    showToast(`Oportunidade movida para ${getStage(stageId).label}.`, "success");
  } catch (error) {
    conversation.custom_attributes = previousAttributes;
    renderAll();
    showToast(`Não foi possível mover a oportunidade: ${error.message}`, "error");
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
  const tasks = filteredConversations()
    .filter((conversation) => getCustomAttributes(conversation).crm_next_task)
    .sort((a, b) => {
      const aDate = getCustomAttributes(a).crm_task_due_at || "9999-12-31";
      const bDate = getCustomAttributes(b).crm_task_due_at || "9999-12-31";
      return aDate.localeCompare(bDate);
    });

  elements.taskCount.textContent = String(tasks.length);
  elements.tasksList.replaceChildren();

  if (!tasks.length) {
    elements.tasksList.appendChild(createElement("div", "empty-state", "Nenhuma tarefa registrada."));
    return;
  }

  for (const conversation of tasks) {
    const sender = getSender(conversation);
    const attributes = getCustomAttributes(conversation);
    const done = attributes.crm_task_done === true || attributes.crm_task_done === "true";
    const item = createElement("div", `task-item ${done ? "is-complete" : ""}`);
    const button = createElement("button");
    button.type = "button";
    button.append(
      createElement("strong", null, `${done ? "✓ " : ""}${attributes.crm_next_task}`),
      createElement("span", null, `${sender.name || `Conversa #${conversation.id}`} · ${getStage(getConversationStage(conversation)).label}`)
    );
    button.addEventListener("click", () => openOpportunityDrawer(conversation.id));
    const due = createElement(
      "span",
      `task-due ${isOverdue(attributes.crm_task_due_at, done) ? "overdue" : ""}`,
      attributes.crm_task_due_at ? formatDate(attributes.crm_task_due_at, { dateOnly: true }) : "Sem prazo"
    );
    item.append(button, due);
    elements.tasksList.appendChild(item);
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

  const labelOptions = state.labels.map((label) => ({
    id: label.title || label.name || label,
    name: label.title || label.name || label,
  }));
  fillSelect(elements.filterLabel, labelOptions, "Todas as etiquetas");
}

function populateDrawerOptions() {
  elements.drawerStage.replaceChildren();
  for (const stage of PIPELINE_STAGES) {
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

async function openOpportunityDrawer(conversationId) {
  const conversation = state.conversations.find((item) => Number(item.id) === Number(conversationId));
  if (!conversation) return;

  state.currentConversationId = Number(conversationId);
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
  elements.drawerTaskDone.checked = attributes.crm_task_done === true || attributes.crm_task_done === "true";
  elements.drawerLossReason.value = attributes.crm_loss_reason || "";
  toggleLossReason();

  elements.drawerLabels.replaceChildren();
  for (const label of getLabels(conversation)) {
    elements.drawerLabels.appendChild(createElement("span", "label-chip", label));
  }

  elements.drawer.classList.add("is-open");
  elements.drawer.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  await loadMessages();
}

function closeOpportunityDrawer() {
  elements.drawer.classList.remove("is-open");
  elements.drawer.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  state.currentConversationId = null;
}

function toggleLossReason() {
  elements.lossReasonField.classList.toggle("is-hidden", elements.drawerStage.value !== "lost");
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
  elements.messageThread.replaceChildren();
  if (!Array.isArray(messages) || !messages.length) {
    elements.messageThread.appendChild(createElement("div", "empty-state", "Nenhuma mensagem disponível."));
    return;
  }

  for (const message of messages) {
    const content = message.content || message.processed_message_content || attachmentDescription(message);
    if (!content) continue;
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
  }

  elements.messageThread.scrollTop = elements.messageThread.scrollHeight;
}

function attachmentDescription(message) {
  const attachments = message.attachments || (message.attachment ? [message.attachment] : []);
  if (!attachments.length) return "";
  return `[${attachments[0].file_type || attachments[0].extension || "arquivo"}]`;
}

async function saveOpportunity() {
  const conversationId = state.currentConversationId;
  const conversation = state.conversations.find((item) => Number(item.id) === conversationId);
  if (!conversation) return;

  elements.saveOpportunity.disabled = true;
  try {
    const customAttributes = {
      ...getCustomAttributes(conversation),
      crm_stage: elements.drawerStage.value,
      crm_value: elements.drawerValue.value ? Number(elements.drawerValue.value) : null,
      crm_next_task: elements.drawerTask.value.trim(),
      crm_task_due_at: elements.drawerDueDate.value || null,
      crm_task_done: elements.drawerTaskDone.checked,
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

    if (selectedAssignee !== currentAssigneeId || (!selectedAssignee && selectedTeam !== currentTeamId)) {
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

    renderAll();
    showToast("Oportunidade atualizada.", "success");
  } catch (error) {
    showToast(`Erro ao salvar: ${error.message}`, "error");
  } finally {
    elements.saveOpportunity.disabled = false;
  }
}

async function updateCustomAttributes(conversationId, customAttributes) {
  return apiRequest(
    `/api/v1/accounts/${state.accountId}/conversations/${conversationId}/custom_attributes`,
    {
      method: "POST",
      body: JSON.stringify({ custom_attributes: customAttributes }),
    }
  );
}

async function sendReply(event) {
  event.preventDefault();
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
    showToast("Atributos CRM verificados.", result.errors?.length ? "error" : "success");
  } catch (error) {
    elements.bootstrapResult.textContent = `Erro: ${error.message}`;
    showToast(`Falha na configuração: ${error.message}`, "error");
  } finally {
    elements.bootstrapCrm.disabled = false;
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
  state.filters = { assignee: "", team: "", inbox: "", label: "" };
  elements.filterAssignee.value = "";
  elements.filterTeam.value = "";
  elements.filterInbox.value = "";
  elements.filterLabel.value = "";
  renderAll();
}

function cacheElements() {
  Object.assign(elements, {
    loginScreen: byId("login-screen"),
    loginForm: byId("login-form"),
    loginToken: byId("login-token"),
    loginAccount: byId("login-account"),
    loginSubmit: byId("login-submit"),
    loginError: byId("login-error"),
    app: byId("app"),
    sidebarAccountId: byId("sidebar-account-id"),
    settingsAccountId: byId("settings-account-id"),
    pageEyebrow: byId("page-eyebrow"),
    pageTitle: byId("page-title"),
    globalSearch: byId("global-search"),
    refreshButton: byId("refresh-button"),
    metricsGrid: byId("metrics-grid"),
    stageOverview: byId("stage-overview"),
    dashboardTasks: byId("dashboard-tasks"),
    recentConversations: byId("recent-conversations"),
    pipelineBoard: byId("pipeline-board"),
    filterAssignee: byId("filter-assignee"),
    filterTeam: byId("filter-team"),
    filterInbox: byId("filter-inbox"),
    filterLabel: byId("filter-label"),
    clearFilters: byId("clear-filters"),
    conversationCount: byId("conversation-count"),
    conversationsTable: byId("conversations-table"),
    taskCount: byId("task-count"),
    tasksList: byId("tasks-list"),
    contactCount: byId("contact-count"),
    contactsTable: byId("contacts-table"),
    bootstrapCrm: byId("bootstrap-crm"),
    bootstrapResult: byId("bootstrap-result"),
    logoutButton: byId("logout-button"),
    drawer: byId("opportunity-drawer"),
    drawerConversationId: byId("drawer-conversation-id"),
    drawerContactName: byId("drawer-contact-name"),
    drawerContactMeta: byId("drawer-contact-meta"),
    drawerStage: byId("drawer-stage"),
    drawerValue: byId("drawer-value"),
    drawerPriority: byId("drawer-priority"),
    drawerAssignee: byId("drawer-assignee"),
    drawerTeam: byId("drawer-team"),
    drawerTask: byId("drawer-task"),
    drawerDueDate: byId("drawer-due-date"),
    drawerTaskDone: byId("drawer-task-done"),
    lossReasonField: byId("loss-reason-field"),
    drawerLossReason: byId("drawer-loss-reason"),
    drawerLabels: byId("drawer-labels"),
    saveOpportunity: byId("save-opportunity"),
    openChatwoot: byId("open-chatwoot"),
    reloadMessages: byId("reload-messages"),
    messageThread: byId("message-thread"),
    replyForm: byId("reply-form"),
    replyContent: byId("reply-content"),
    replyPrivate: byId("reply-private"),
    replySubmit: byId("reply-submit"),
    loadingOverlay: byId("loading-overlay"),
    loadingMessage: byId("loading-message"),
    toastContainer: byId("toast-container"),
  });
}

function bindEvents() {
  elements.loginForm.addEventListener("submit", handleLogin);
  elements.logoutButton.addEventListener("click", logout);
  elements.refreshButton.addEventListener("click", loadWorkspace);
  elements.bootstrapCrm.addEventListener("click", bootstrapCrm);
  elements.clearFilters.addEventListener("click", clearFilters);
  elements.drawerStage.addEventListener("change", toggleLossReason);
  elements.saveOpportunity.addEventListener("click", saveOpportunity);
  elements.openChatwoot.addEventListener("click", openInChatwoot);
  elements.reloadMessages.addEventListener("click", loadMessages);
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
    renderAll();
  });

  const filterBindings = [
    [elements.filterAssignee, "assignee"],
    [elements.filterTeam, "team"],
    [elements.filterInbox, "inbox"],
    [elements.filterLabel, "label"],
  ];

  for (const [select, key] of filterBindings) {
    select.addEventListener("change", () => {
      state.filters[key] = select.value;
      renderAll();
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && elements.drawer.classList.contains("is-open")) {
      closeOpportunityDrawer();
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  cacheElements();
  bindEvents();
  initializeSession();
});
