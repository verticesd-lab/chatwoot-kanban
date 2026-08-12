const access = require("./access-control");

function operationalRole(session) {
  return String(
    session?.operational_role || session?.operationalRole || ""
  ).toLowerCase();
}

function filterConversationsForReactivation(session, conversations) {
  const source = Array.isArray(conversations) ? conversations : [];
  if (operationalRole(session) === "sdr") return [...source];
  return access.filterConversationsForSession(session, source);
}

module.exports = {
  filterConversationsForReactivation,
};
