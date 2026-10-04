// Writes one guided notebook outside VS Code, the same way "Guide me through this" does, and reports
// how good it came out: the code's checks before and after review, the review's scores and fixes,
// the repairs, and the time and cost of each call. With --judge, a fresh review scores the final page.
//
//   node scripts/guide-eval.js <project-root> <subject-id> [--provider claude|codex] [--model sonnet] [--judge]
//
// It writes .regain/capability-<id>.regain.md and .guide.json in the project, like the extension does.
const Module = require("module");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const provider = flag("--provider") || "claude", model = flag("--model");
const judge = args.includes("--judge") && args.splice(args.indexOf("--judge"), 1);
const [rootArg, id] = args;
if (!rootArg || !id) { console.error("Usage: node scripts/guide-eval.js <project-root> <subject-id> [--provider claude|codex] [--model name] [--judge]"); process.exit(2); }
const root = path.resolve(rootArg);

// Just enough of VS Code for the agent runner: settings, the provider choice, and a log on stderr.
const settings = {claudeModel: model || "sonnet", codexModel: provider === "codex" ? model || "" : ""};
const fake = {
  workspace: {getConfiguration: () => ({get: (key, fallback) => settings[key] ?? fallback})},
  extensions: {getExtension: () => null},
  window: {showQuickPick: async items => items.find(item => item.provider === provider),
    createOutputChannel: () => ({appendLine: line => process.stderr.write(line + "\n"), show() {}})},
};
const load = Module._load;
Module._load = (request, ...rest) => request === "vscode" ? fake : load(request, ...rest);

const {run, reviewPrompt} = require("../agent-runner");
const {writeGuide, checkNotebook} = require("../guide");
const {findCapability} = require("../semantic-map");
const {loadLearner} = require("../conversation");
const {savedNotes} = require("../file-notes");
const {buildIndex} = require("../project-index");
const {projectBudget, notebookLimits} = require("../budget");

const scoreLine = scores => (scores || []).map(item => `  ${String(item.score).padStart(2)}  ${item.criterion}: ${item.note}`).join("\n");

(async () => {
  const map = JSON.parse(await fs.promises.readFile(path.join(root, ".regain", "semantic-map.json"), "utf8"));
  const capability = findCapability(map, id);
  if (!capability) throw new Error(`No subject "${id}" in the map. Subjects: ${map.capabilities.map(item => item.id).join(", ")}`);
  const started = new Date().toISOString();
  const call = (kind, request, title) => run(root, kind, request, null, () => {}, title);
  const result = await writeGuide(root, map, capability, {call, learner: await loadLearner(root),
    context: {notes: await savedNotes(root), index: await buildIndex(root)}});
  const record = JSON.parse(await fs.promises.readFile(result.recordPath, "utf8"));

  console.log(`\nGuide for ${capability.name}: ${path.relative(root, result.notebookPath)}`);
  console.log(`Draft:  ${record.checks.draft.errors.length} hard errors, ${record.checks.draft.warnings.length} warnings`);
  for (const item of record.checks.draft.errors) console.log(`  - ${item}`);
  if (record.review) {
    console.log(`Review scores of the draft (1-5):\n${scoreLine(record.review.scores)}`);
    console.log(`Review fixed ${record.review.problems.length} problems:`);
    for (const item of record.review.problems) console.log(`  - ${item.where}: ${item.problem} -> ${item.fix}`);
  }
  console.log(`Final:  ${record.checks.final.errors.length} hard errors, ${record.checks.final.warnings.length} warnings`);
  for (const item of [...record.checks.final.errors, ...record.checks.final.warnings]) console.log(`  - ${item}`);
  for (const item of [...record.repairs, ...record.problems]) console.log(`  ! ${item}`);

  if (judge) {
    const limits = notebookLimits(await projectBudget(root));
    const raw = await call("review", await reviewPrompt(root, map, capability, record.notebook, await checkNotebook(root, record.notebook, limits)), `Judging the guide for ${capability.name}`);
    const scores = raw.scores || [];
    console.log(`Judge scores of the final page (1-5):\n${scoreLine(scores)}`);
    console.log(`  Mean ${(scores.reduce((sum, item) => sum + item.score, 0) / Math.max(scores.length, 1)).toFixed(1)}, with ${(raw.problems || []).length} problems still found.`);
  }

  const runs = (await fs.promises.readFile(path.join(root, ".regain", "agent-runs.jsonl"), "utf8")).split("\n").filter(Boolean)
    .map(line => JSON.parse(line)).filter(entry => entry.at >= started);
  console.log("Calls:");
  for (const entry of runs) console.log(`  ${entry.kind.padEnd(7)} ${(entry.ms / 1000).toFixed(0).padStart(4)}s${entry.costUsd ? `  $${entry.costUsd.toFixed(2)}` : ""}${entry.ok ? "" : `  failed: ${entry.error}`}`);
})().catch(error => { console.error(error.message); process.exit(1); });
