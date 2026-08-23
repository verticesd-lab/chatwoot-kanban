const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const script = fs.readFileSync(path.join(root, "src", "script.js"), "utf8");
const renderStart = script.indexOf("function renderArchive()");
const renderEnd = script.indexOf("function archiveScopeForReason", renderStart);
assert(renderStart >= 0 && renderEnd > renderStart, "renderArchive deve continuar isolavel para teste");

function createElement(tag, className, text) {
  return {
    tag,
    className,
    textContent: text ?? "",
    children: [],
    listeners: {},
    append(...items) {
      this.children.push(...items);
    },
    appendChild(item) {
      this.children.push(item);
      return item;
    },
    replaceChildren(...items) {
      this.children = [...items];
    },
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
  };
}

let archiveItems = [];
const restored = [];
const opened = [];
const archiveList = createElement("div", "archive-list");
const context = {
  Date,
  PIPELINE_COLUMN_PAGE_SIZE: 50,
  state: { archiveLimit: 50 },
  elements: {
    archiveList,
    archiveCount: { textContent: "0" },
  },
  archivedSearchResults: () => [...archiveItems],
  hasPermission: () => true,
  createElement,
  getSender: (conversation) => conversation.meta?.sender || {},
  formatDate: (value) => `formatted:${value}`,
  openOpportunityDrawer: (conversationId) => opened.push(Number(conversationId)),
  restoreOpportunity: (conversationId) => restored.push(Number(conversationId)),
};

vm.runInNewContext(
  `${script.slice(renderStart, renderEnd)}; this.renderArchiveForTest = renderArchive;`,
  context
);

function renderOne(conversation) {
  archiveItems = [conversation];
  context.renderArchiveForTest();
  assert.strictEqual(archiveList.children.length, 1, "a conversa deve ser renderizada no Arquivo");
  const row = archiveList.children[0];
  return { info: row.children[0], actions: row.children[1] };
}

function button(actions, label) {
  return actions.children.find((item) => item.tag === "button" && item.textContent === label);
}

function metadata(info) {
  return info.children.find((item) => item.tag === "small")?.textContent;
}

const legacyManual = {
  id: 501,
  meta: { sender: { name: "Lead legado", phone_number: "+55 65 90000-0501" } },
  crm_archive: {
    reason: "Duplicado",
    archivedByName: "Gestor",
    archivedAt: "2026-08-20T12:00:00.000Z",
    note: "Registro manual",
  },
};
let rendered = renderOne(legacyManual);
assert.strictEqual(
  metadata(rendered.info),
  "Duplicado · arquivado por Gestor em formatted:2026-08-20T12:00:00.000Z"
);
assert(rendered.info.children.some((item) => item.tag === "p" && item.textContent === "Registro manual"));
let restore = button(rendered.actions, "Restaurar");
assert(restore, "arquivo legado sem archiveSource deve manter Restaurar");
restore.listeners.click();
assert.deepStrictEqual(restored, [501]);

const explicitManual = {
  ...legacyManual,
  id: 502,
  archiveSource: "manual",
};
rendered = renderOne(explicitManual);
restore = button(rendered.actions, "Restaurar");
assert(restore, "archiveSource manual deve manter Restaurar");
restore.listeners.click();
assert.deepStrictEqual(restored, [501, 502]);

const chatwootResolved = {
  ...legacyManual,
  id: 503,
  archiveSource: "chatwoot_resolved",
  crm_archive: {
    reason: "Nao deve aparecer",
    archivedByName: "Nao deve aparecer",
    archivedAt: "2026-08-20T12:00:00.000Z",
    note: "Nao deve aparecer",
  },
};
rendered = renderOne(chatwootResolved);
assert.strictEqual(metadata(rendered.info), "Resolvida no Chatwoot");
assert(!rendered.info.children.some((item) => item.tag === "p"));
assert.strictEqual(button(rendered.actions, "Restaurar"), undefined);
const open = button(rendered.actions, "Ver histórico");
assert(open, "arquivo derivado deve preservar acesso ao historico");
open.listeners.click();
assert.deepStrictEqual(opened, [503]);
assert.deepStrictEqual(restored, [501, 502], "arquivo derivado nao pode disparar restore");

console.log("CRM archive manual and Chatwoot-resolved rendering tests: OK");
