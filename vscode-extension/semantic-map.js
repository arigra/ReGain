const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {semanticDiagram} = require("./semantic-tree-diagram");
const {completeCoverage, saveCoverage} = require("./file-coverage");

const posix = value => value.split(path.sep).join("/");
const clean = value => String(value || "").trim().slice(0, 1200);
const slug = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
// Text the user reads never carries semicolons or long dashes (they read as machine-written).
// Number ranges keep a plain hyphen; inline code between backticks is left alone.
function tidy(value) {
  return String(value || "").split(/(`[^`]*`)/).map((part, i) => i % 2 ? part : part
    .replace(/(\d)\s*[–—]\s*(\d)/g, "$1-$2")
    .replace(/\s*[–—]\s*/g, ", ")
    .replace(/;\s+(\S)/g, (_, next) => ". " + next.toUpperCase())
    .replace(/;/g, ". ").replace(/  +/g, " ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/,\s*,/g, ",")).join("");
}
const text = value => tidy(clean(value));
const kindOf = value => ["code", "experiment", "status"].includes(value) ? value : "code";
const stateOf = value => ["done", "in_progress", "not_started", "unknown"].includes(value) ? value : "unknown";
async function sourcePath(root, value) {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || value.includes("\\") || value.split("/").includes("..")) return null;
  const realRoot = await fs.promises.realpath(root);
  const target = path.resolve(root, value);
  let realTarget;
  try { realTarget = await fs.promises.realpath(target); }
  catch { return null; }
  if (!realTarget.startsWith(realRoot + path.sep)) return null;
  const stat = await fs.promises.stat(realTarget);
  return stat.isFile() ? posix(path.relative(root, target)) : null;
}

async function normalizeMap(root, raw) {
  if (!raw || !Array.isArray(raw.capabilities)) throw new Error("Agent returned no capabilities");
  if (raw.capabilities.length > 80) throw new Error("The agent found more than 80 top-level capabilities; the overview cannot safely show them all");
  const capabilities = [];
  const ids = new Set();
  for (const item of raw.capabilities.slice(0, 80)) {
    const id = slug(item.id || item.name);
    if (!id || ids.has(id)) throw new Error(`Invalid or duplicate capability id: ${item.id || item.name}`);
    ids.add(id);
    const sources = [];
    for (const source of (item.sources || []).slice(0, 100)) {
      const file = await sourcePath(root, source.path);
      if (file && !sources.some(entry => entry.path === file)) sources.push({path: file, reason: text(source.reason)});
    }
    const flow = [];
    for (const stage of (item.flow || []).slice(0, 20)) {
      const paths = [];
      for (const candidate of (stage.sources || []).slice(0, 40)) {
        const file = await sourcePath(root, candidate);
        if (file && !paths.includes(file)) paths.push(file);
      }
      if (!paths.length) continue;
      for (const file of paths) if (!sources.some(entry => entry.path === file)) sources.push({path: file, reason: text(stage.description)});
      flow.push({id: slug(stage.id || stage.label), label: text(stage.label), description: text(stage.description), state: stateOf(stage.state), sources: paths});
    }
    if (!sources.length || !flow.length) throw new Error(`Capability ${item.name} has no verified sources or execution flow`);
    capabilities.push({id, name: text(item.name), purpose: text(item.purpose), kind: kindOf(item.kind),
      role: item.role === "side" ? "side" : "flow", state: stateOf(item.state),
      runtimeStatus: ["runtime", "research", "evaluation", "tooling", "unknown"].includes(item.runtimeStatus) ? item.runtimeStatus : "unknown",
      sources, flow, related: (item.related || []).map(slug).filter(Boolean).slice(0, 20)});
  }
  if (!capabilities.length) throw new Error("The agent map had no capabilities with verified source files");
  const valid = new Set(capabilities.map(item => item.id));
  for (const cap of capabilities) cap.related = cap.related.filter(id => valid.has(id) && id !== cap.id);
  const story = raw.story && ["asks", "done", "next"].every(key => String(raw.story[key] || "").trim())
    ? {asks: text(raw.story.asks), done: text(raw.story.done), next: text(raw.story.next)} : null;
  const terms = [];
  for (const item of raw.terms || []) {
    const term = text(item.term).slice(0, 60), meaning = text(item.meaning);
    if (term && meaning && !terms.some(entry => entry.term.toLowerCase() === term.toLowerCase())) terms.push({term, meaning});
  }
  return {generatedByReGain: true, version: 1, projectName: clean(raw.projectName || path.basename(root)),
    summary: text(raw.summary), ...(story ? {story} : {}), capabilities, terms: terms.slice(0, 12),
    openQuestions: (raw.openQuestions || []).map(text).filter(Boolean).slice(0, 8),
    uncertainties: (raw.uncertainties || []).map(text).filter(Boolean).slice(0, 30)};
}

function findCapability(map, id) {
  const visit = items => {
    for (const item of items || []) {
      if (item.id === id) return item;
      const nested = visit(item.children);
      if (nested) return nested;
    }
    return null;
  };
  return visit(map.capabilities);
}

function scopedCapability(capability) {
  const sources = new Map();
  const collect = node => {
    for (const item of node.sources || []) if (!sources.has(item.path)) sources.set(item.path, item);
    for (const child of node.children || []) collect(child);
  };
  collect(capability);
  return {...capability, sources: [...sources.values()]};
}

async function normalizeBranch(root, parent, raw) {
  if (!raw || !Array.isArray(raw.children)) throw new Error("Agent returned no branch result");
  if (raw.children.length > 30) throw new Error(`The agent found more than 30 features under ${parent.name}; the overview cannot safely show them all`);
  const children = [], seen = new Set();
  for (const item of raw.children.slice(0, 30)) {
    const segment = slug(item.id || item.name);
    if (!segment || seen.has(segment)) throw new Error(`Invalid or duplicate feature id under ${parent.name}: ${item.id || item.name}`);
    seen.add(segment);
    const sources = [];
    for (const source of (item.sources || []).slice(0, 80)) {
      const verified = await sourcePath(root, source.path);
      if (verified && !sources.some(entry => entry.path === verified)) sources.push({path: verified, reason: text(source.reason)});
    }
    const flow = [];
    for (const step of (item.flow || []).slice(0, 20)) {
      const paths = [];
      for (const candidate of (step.sources || []).slice(0, 30)) {
        const verified = await sourcePath(root, candidate);
        if (verified && !paths.includes(verified)) paths.push(verified);
      }
      if (!paths.length) continue;
      for (const verified of paths) if (!sources.some(entry => entry.path === verified)) sources.push({path: verified, reason: text(step.description)});
      flow.push({id: slug(step.id || step.label), label: text(step.label), description: text(step.description), state: stateOf(step.state), sources: paths});
    }
    if (!sources.length || !flow.length) throw new Error(`Feature ${item.name} has no verified sources or execution flow`);
    const longId = `${parent.id}--${segment}`;
    const childId = longId.length <= 90 ? longId
      : `${parent.id.slice(0, 42)}--${segment.slice(0, 28)}-${crypto.createHash("sha1").update(longId).digest("hex").slice(0, 8)}`;
    children.push({id: childId, name: text(item.name), purpose: text(item.purpose), kind: kindOf(item.kind), state: stateOf(item.state),
      runtimeStatus: ["runtime", "research", "evaluation", "tooling", "unknown"].includes(item.runtimeStatus) ? item.runtimeStatus : "unknown",
      sources, flow, related: [], refined: false, children: []});
  }
  return children;
}

async function saveBranch(root, id, raw) {
  const file = path.join(root, ".regain", "semantic-map.json");
  const map = JSON.parse(await fs.promises.readFile(file, "utf8"));
  if (!map.generatedByReGain) throw new Error("The capability map is not a ReGain analysis");
  const parent = findCapability(map, id);
  if (!parent) throw new Error("Capability was not found in the current map");
  const children = await normalizeBranch(root, parent, raw);
  parent.children = children;
  parent.refined = true;
  const notes = (raw.uncertainties || []).map(text).filter(Boolean).slice(0, 20);
  if (notes.length) parent.refinementNotes = notes;
  try {
    const coverage = JSON.parse(await fs.promises.readFile(path.join(root, ".regain", "file-coverage.json"), "utf8"));
    if (coverage.generatedByReGain && coverage.complete) {
      map.coverage = completeCoverage(coverage, map);
      await saveCoverage(root, coverage);
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await saveMap(root, map);
  return {parent, children};
}

async function overviewPath(root) {
  const regain = path.join(root, ".regain");
  await fs.promises.mkdir(regain, {recursive: true});
  const overview = path.join(regain, "overview.html");
  try {
    const previous = await fs.promises.readFile(overview, "utf8");
    if (!/REGAIN_(?:TREE|GENERATED|SEMANTIC|ANALYZING)_V1/.test(previous)) {
      const backup = path.join(regain, "overview.before-regain.html");
      try { await fs.promises.copyFile(overview, backup, fs.constants.COPYFILE_EXCL); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return overview;
}

async function showAnalyzing(root, error = "") {
  const file = await overviewPath(root);
  const message = error ? `Analysis stopped: ${error}` : "ReGain is tracing capabilities and accounting for repository files. Large repositories can take a while; progress appears in the ReGain notification.";
  const safe = message.replace(/[&<>"']/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[char]));
  await fs.promises.writeFile(file, `<!doctype html><!-- REGAIN_ANALYZING_V1 --><html lang="en"><head><meta charset="utf-8"><title>ReGain analysis</title><style>:root{font-family:system-ui;color-scheme:light dark;background:#10202c;color:#f1f7f8}body{margin:0;padding:clamp(24px,6vw,70px)}main{max-width:700px;margin:auto}small{color:#75d9df;letter-spacing:.15em;font-weight:800}h1{font-size:2.5rem}p{line-height:1.6;color:#b9cbd2}button{background:#153c47;color:#8ee2e4;border:1px solid #5ac7ce;border-radius:9px;padding:10px 15px;font:inherit;cursor:pointer}</style></head><body><main><small>REGAIN · PROJECT ANALYSIS</small><h1>Learning this project</h1><p>${safe}</p>${error ? '<button id="retry">Run analysis again</button>' : ""}</main>${error ? '<script>window.addEventListener("DOMContentLoaded",()=>document.getElementById("retry").addEventListener("click",()=>window.regainApi.postMessage({type:"retryAnalysis"})));</script>' : ""}</body></html>`, "utf8");
  return file;
}

async function mergePreviousMap(root, map) {
  const data = path.join(root, ".regain", "semantic-map.json");
  try {
    const previous = JSON.parse(await fs.promises.readFile(data, "utf8"));
    if (!previous.generatedByReGain) throw new Error("Existing semantic-map.json was not generated by ReGain");
    const preserveExplored = (items, oldItems) => {
      for (const item of items || []) {
        const old = (oldItems || []).find(entry => entry.id === item.id);
        if (!old) continue;
        if (item.children === undefined || (!item.children.length && old.children?.length)) {
          item.children = old.children;
          item.refined = old.refined;
          item.refinementNotes = old.refinementNotes;
        } else preserveExplored(item.children, old.children);
      }
      for (const old of oldItems || []) {
        if (items.some(item => item.id === old.id)) continue;
        if ((old.sources || []).length && old.sources.every(source => fs.existsSync(path.join(root, source.path)))) items.push(old);
      }
    };
    preserveExplored(map.capabilities, previous.capabilities);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return map;
}

// merge: keep subjects from the saved map that the new one lacks. Off for conversation edits,
// where a missing subject was merged or removed on purpose.
async function saveMap(root, map, {merge = true} = {}) {
  const regain = path.join(root, ".regain");
  await fs.promises.mkdir(regain, {recursive: true});
  const data = path.join(regain, "semantic-map.json");
  if (merge) await mergePreviousMap(root, map);
  await fs.promises.writeFile(data, JSON.stringify(map, null, 2) + "\n", "utf8");
  const overview = await overviewPath(root);
  await fs.promises.writeFile(overview, semanticDiagram(map), "utf8");
  return overview;
}

module.exports = {tidy, stateOf, sourcePath, normalizeMap, normalizeBranch, showAnalyzing, mergePreviousMap, saveMap, saveBranch, findCapability, scopedCapability};
