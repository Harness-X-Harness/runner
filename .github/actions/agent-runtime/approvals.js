function codexApproval(method, params) {
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
    const decisions = params.availableDecisions ?? ["accept", "decline", "cancel"];
    const decision = Array.isArray(decisions) && decisions.find((value) =>
      typeof value === "string" && /^(accept|allow|approved)/i.test(value));
    if (!decision) throw new Error("Codex approval has no supported decision");
    return { decision };
  }
  if (method === "item/permissions/requestApproval") {
    if (!params.permissions || typeof params.permissions !== "object" || Array.isArray(params.permissions)) {
      throw new Error("Codex permission request is invalid");
    }
    return { permissions: structuredClone(params.permissions), scope: "session" };
  }
}

function grokApproval(params) {
  const allowed = Array.isArray(params.options) && params.options.find((option) =>
    option && ["allow_once", "allow_always"].includes(option.kind) &&
    typeof option.optionId === "string" && option.optionId &&
    typeof option.name === "string" && option.name.trim());
  if (!allowed) throw new Error("Grok permission request has no supported choice");
  return { outcome: { outcome: "selected", optionId: allowed.optionId } };
}

module.exports = { codexApproval, grokApproval };
