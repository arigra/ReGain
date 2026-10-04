// The overview conversation and the record of what the user knows, kept in .regain/
// so they survive redraws and restarts, and so notebooks can read the record.
const fs = require("fs");
const path = require("path");
const {tidy} = require("./semantic-map");

const files = root => ({conversation: path.join(root, ".regain", "conversation.json"), learner: path.join(root, ".regain", "learner.json"),
  progress: path.join(root, ".regain", "progress.json")});

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.promises.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

async function writeJson(file, value) {
  await fs.promises.mkdir(path.dirname(file), {recursive: true});
  await fs.promises.writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

const loadConversation = async root => readJson(files(root).conversation, []);
const saveConversation = (root, messages) => writeJson(files(root).conversation, messages);
const emptyRecord = () => ({knows: [], cares: [], open: [], told: [], updatedAt: null});
const loadLearner = async root => ({...emptyRecord(), ...(await readJson(files(root).learner, {}))});

// told: facts the user gave ReGain (kept across map rebuilds, read by every prompt).
async function saveLearner(root, record, newFacts = []) {
  const short = (list, cap = 12) => [...new Set((list || []).map(item => tidy(String(item).trim())).filter(Boolean))].slice(-cap);
  const previous = await loadLearner(root);
  const value = {knows: short(record.knows), cares: short(record.cares), open: short(record.open),
    told: short([...(previous.told || []), ...(record.told || []), ...newFacts], 20), updatedAt: new Date().toISOString()};
  await writeJson(files(root).learner, value);
  return value;
}

function learnerText(record) {
  const told = record?.told?.length ? `\nFacts the user told ReGain (trust these over the files when they conflict): ${record.told.join(" · ")}` : "";
  if (!record || ![record.knows, record.cares, record.open].some(list => list?.length)) return "Nothing is known yet about what the user knows or cares about." + told;
  const line = (label, list) => `${label}: ${list?.length ? list.join(" · ") : "nothing yet"}`;
  return [line("The user already knows", record.knows), line("The user cares most about", record.cares), line("Still open for the user", record.open)].join("\n") + told;
}

// The user's path through the subjects: guides they started, subjects they marked as understood.
const loadProgress = async root => ({started: [], covered: [], ...(await readJson(files(root).progress, {}))});
async function updateProgress(root, change) {
  const progress = await loadProgress(root);
  const toggle = (list, id, on) => on ? [...new Set([...list, id])] : list.filter(item => item !== id);
  if (change.started) progress.started = toggle(progress.started, change.started, true);
  if (change.covered !== undefined) progress.covered = toggle(progress.covered, change.id, change.covered);
  await writeJson(files(root).progress, progress);
  return progress;
}

module.exports = {loadConversation, saveConversation, loadLearner, saveLearner, learnerText, loadProgress, updateProgress};
