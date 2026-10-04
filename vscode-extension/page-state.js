// Everything the overview page shows besides the map: the conversation, the user's record and
// path, which subjects already have a guide, and how long each kind of agent call usually takes.
const fs = require("fs");
const path = require("path");
const {loadConversation, loadLearner, loadProgress} = require("./conversation");

// Median time of the last successful runs of each kind, from .regain/agent-runs.jsonl.
async function estimates(root) {
  try { return medians((await fs.promises.readFile(path.join(root, ".regain", "agent-runs.jsonl"), "utf8")).split("\n").filter(Boolean)); }
  catch { return {}; }
}
// The map's words, for hover text in notebooks too.
function termsSync(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, ".regain", "semantic-map.json"), "utf8")).terms || []; }
  catch { return []; }
}
function medians(lines) {
  const byKind = {};
  for (const line of lines) {
    let run;
    try { run = JSON.parse(line); } catch { continue; }
    if (!run.ok || !run.ms || !run.kind) continue;
    // The opening message is a separate, heavier kind of chat call.
    const kind = run.kind === "chat" && /^Opening/.test(run.title || "") ? "opening" : run.kind;
    (byKind[kind] = byKind[kind] || []).push(run.ms);
  }
  const result = {};
  for (const [kind, times] of Object.entries(byKind)) {
    const recent = times.slice(-8).sort((a, b) => a - b);
    result[kind] = recent[Math.floor(recent.length / 2)];
  }
  return result;
}

// Subject ids that already have a guided notebook.
async function notebooks(root) {
  try {
    return (await fs.promises.readdir(path.join(root, ".regain")))
      .map(name => name.match(/^capability-(.+)\.regain\.md$/)?.[1]).filter(Boolean);
  } catch { return []; }
}

async function pageState(root) {
  const [conversation, learner, progress, guides, times] = await Promise.all([
    loadConversation(root), loadLearner(root), loadProgress(root), notebooks(root), estimates(root)]);
  return {conversation, learner, progress, notebooks: guides, estimates: times};
}

module.exports = {pageState, estimates, termsSync, notebooks};
