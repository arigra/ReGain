// The overview conversation: one agent call per message. The agent answers, applies the map
// changes the user asked for, proposes others (Apply / Skip), and updates the user's record.
const fs = require("fs");
const path = require("path");
const {chatPrompt} = require("./agent-runner");
const {applyOps} = require("./map-ops");
const {saveMap, findCapability, tidy} = require("./semantic-map");
const {loadConversation, saveConversation, loadLearner, saveLearner, loadProgress} = require("./conversation");
const {buildIndex} = require("./project-index");
const {savedNotes} = require("./file-notes");
const {pageState} = require("./page-state");


const busy = new Set();
const readMap = async root => JSON.parse(await fs.promises.readFile(path.join(root, ".regain", "semantic-map.json"), "utf8"));

// deps: {run, post(message), report(text)}. post sends live updates to every open overview page.
async function sendMessage(root, {text, selectedId}, deps) {
  if (busy.has(root)) return deps.post({type: "chatBusy"});
  busy.add(root);
  const messages = await loadConversation(root);
  try {
    const map = await readMap(root);
    if (text) {
      messages.push({role: "user", text: String(text).slice(0, 4000), at: new Date().toISOString()});
      await saveConversation(root, messages);
    }
    const learner = await loadLearner(root);
    deps.post({type: "state", conversation: messages, learner, pending: true});
    const index = await buildIndex(root);
    const selected = selectedId ? findCapability(map, selectedId) : null;
    const request = await chatPrompt(root, map, {messages, learner, selected, index, notes: await savedNotes(root), progress: await loadProgress(root)});
    request.onStep = (line, time) => deps.post({type: "chatProgress", text: line, time});
    const result = await deps.run(root, "chat", request, null, deps.report, messages.length ? "Answering" : "Opening the conversation");
    const plainOps = list => (list || []).filter(Boolean).map(op => ({...op, reason: tidy(op.reason || "")}));
    const {applied, rejected} = applyOps(map, plainOps(result.apply), root);
    // The opening message only introduces. The record, facts and open questions change once the user speaks.
    const userSpoke = messages.some(m => m.role === "user");
    let questionsChanged = false;
    if (userSpoke && Array.isArray(result.openQuestions)) {
      const next = result.openQuestions.map(q => tidy(String(q).trim())).filter(Boolean).slice(0, 8);
      questionsChanged = JSON.stringify(next) !== JSON.stringify(map.openQuestions || []);
      map.openQuestions = next;
    }
    if (applied.length || questionsChanged) await saveMap(root, map, {merge: false});
    const notes = rejected.map(item => `I could not ${item.op} that: ${item.why}.`);
    messages.push({role: "agent", text: tidy([result.reply, ...notes].filter(Boolean).join("\n\n")), at: new Date().toISOString(),
      applied, suggested: plainOps(result.suggest).map(op => ({...op, status: "pending"}))});
    await saveConversation(root, messages);
    if (userSpoke) await saveLearner(root, result.record || learner, (result.facts || []).filter(Boolean));
    deps.post({type: "state", map, ...(await pageState(root)), glow: applied.flatMap(item => item.ids)});
  } catch (error) {
    messages.push({role: "agent", status: "error", text: `Stopped: ${error.message}`, at: new Date().toISOString()});
    await saveConversation(root, messages).catch(() => {});
    deps.post({type: "state", ...(await pageState(root))});
  } finally {
    busy.delete(root);
  }
}

// Apply or skip one change the agent suggested.
async function decideSuggestion(root, {message, index, apply}, deps) {
  const messages = await loadConversation(root);
  const suggestion = messages[message]?.suggested?.[index];
  if (!suggestion || suggestion.status !== "pending") return;
  const map = await readMap(root);
  let glow = [];
  if (apply) {
    const {applied, rejected} = applyOps(map, [suggestion], root);
    if (applied.length) { await saveMap(root, map, {merge: false}); glow = applied.flatMap(item => item.ids); suggestion.status = "applied"; }
    else suggestion.status = `not applied: ${rejected[0]?.why || "unknown reason"}`;
  } else suggestion.status = "skipped";
  await saveConversation(root, messages);
  deps.post({type: "state", map, ...(await pageState(root)), glow});
}

module.exports = {sendMessage, decideSuggestion};
