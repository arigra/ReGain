// A map of the whole project built without AI: every source file, what it defines, what it
// imports from the project, and whether it is an entry point. The agent gets this up front, so
// it sees the full structure even for files it never opens. ReGain also records which files
// the agent actually read, so gaps in its reading are visible instead of hidden.
const fs = require("fs");
const path = require("path");
const {skippedDirectories} = require("./file-coverage");
const {sourceExtensions, historyDirectories} = require("./budget");

const slash = value => value.split(path.sep).join("/");
const docExtensions = new Set([".md", ".rst", ".txt"]);
const configExtensions = new Set([".yaml", ".yml", ".toml", ".json", ".cfg", ".ini", ".csv", ".tsv"]);
// Job and build scripts: code, even without a usual source extension.
const scriptExtensions = new Set([".sbatch", ".slurm", ".job", ".pbs", ".cmake", ".mk"]);
const scriptNames = new Set(["Makefile", "Dockerfile", "CMakeLists.txt", "Snakefile", "Justfile"]);

function pythonFacts(text) {
  const defs = [...text.matchAll(/^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm)].map(m => m[1]).filter(name => !name.startsWith("_"));
  const imports = [];
  for (const m of text.matchAll(/^\s*from\s+([.\w]+)\s+import\s+([\w*, ()]+)/gm)) imports.push({module: m[1], names: m[2]});
  for (const m of text.matchAll(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm)) for (const name of m[1].split(",")) imports.push({module: name.trim(), names: ""});
  return {defs, imports, entry: /if\s+__name__\s*==\s*["']__main__["']/.test(text)};
}

// Resolve "src.train" or ".losses" to a project file, if it is one.
function resolveImport(module, fromFile, files) {
  const candidates = [];
  if (module.startsWith(".")) {
    const dots = module.match(/^\.+/)[0].length;
    let base = path.posix.dirname(fromFile);
    for (let i = 1; i < dots; i++) base = path.posix.dirname(base);
    const rest = module.slice(dots).replace(/\./g, "/");
    candidates.push(path.posix.join(base, rest));
  } else {
    candidates.push(module.replace(/\./g, "/"));
  }
  for (const stem of candidates) for (const option of [stem + ".py", stem + "/__init__.py"]) {
    const clean = option.replace(/^\.\//, "");
    if (files.has(clean)) return clean;
  }
  return null;
}

async function buildIndex(root) {
  const entries = [];
  async function walk(folder, history) {
    let items;
    try { items = await fs.promises.readdir(path.join(root, folder), {withFileTypes: true}); }
    catch { return; }
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      if (item.isSymbolicLink()) continue;
      const relative = folder ? path.join(folder, item.name) : item.name;
      if (item.isDirectory()) {
        if (!skippedDirectories.has(item.name) && !item.name.startsWith(".")) await walk(relative, history || historyDirectories.has(item.name.toLowerCase()));
        continue;
      }
      const ext = path.extname(item.name).toLowerCase();
      const kind = sourceExtensions.has(ext) || scriptExtensions.has(ext) || scriptNames.has(item.name) ? "code" : docExtensions.has(ext) ? "doc" : configExtensions.has(ext) ? "config" : null;
      if (!kind) continue;
      const stat = await fs.promises.stat(path.join(root, relative));
      if (stat.size > 2 * 1024 * 1024) continue;
      entries.push({path: slash(relative), kind, history, size: stat.size});
    }
  }
  await walk("", false);
  const known = new Set(entries.map(item => item.path));
  for (const item of entries) {
    if (item.kind === "config" && /results?|outputs?|logs?/i.test(item.path)) { item.kind = "result"; continue; }
    if (item.kind !== "code" && item.kind !== "doc") continue;
    const text = await fs.promises.readFile(path.join(root, item.path), "utf8");
    item.lines = text.split("\n").length;
    if (item.kind === "doc") { item.title = (text.match(/^#\s+(.+)$/m) || [])[1] || ""; continue; }
    if (item.path.endsWith(".py")) {
      const facts = pythonFacts(text);
      item.defs = facts.defs;
      item.entry = facts.entry || /(^|\/)scripts\//.test(item.path);
      item.imports = [...new Set(facts.imports.map(i => resolveImport(i.module, item.path, known)).filter(Boolean))];
    } else if (/\.(sh|bash|zsh|ps1|sbatch|slurm|job|pbs)$/.test(item.path)) {
      item.entry = true;
      item.calls = [...new Set([...text.matchAll(/([\w./-]+\.py)\b/g)].map(m => m[1].replace(/^\.\//, "")).filter(file => known.has(file)))];
    }
  }
  return entries;
}

// A compact text version for prompts, capped so a large project does not flood the prompt.
const isTest = file => /(^|\/)tests?\//.test(file) || /(^|\/)test_[^/]*$|_test\.\w+$/.test(file);

function indexText(entries, limit = 22000) {
  const tests = entries.filter(item => item.kind === "code" && !item.history && isTest(item.path));
  const code = entries.filter(item => item.kind === "code" && !item.history && !isTest(item.path));
  const lines = code.map(item => {
    const parts = [`${item.path} (${item.lines} lines${item.entry ? ", entry point" : ""})`];
    if (item.defs?.length) parts.push(`defines ${item.defs.slice(0, 8).join(", ")}${item.defs.length > 8 ? " …" : ""}`);
    if (item.imports?.length) parts.push(`uses ${item.imports.join(", ")}`);
    if (item.calls?.length) parts.push(`runs ${item.calls.join(", ")}`);
    return "- " + parts.join(" · ");
  });
  const docs = entries.filter(item => item.kind === "doc" && !item.history).map(item => `- ${item.path}${item.title ? `: ${item.title}` : ""}`);
  const history = entries.filter(item => item.history).length;
  const results = entries.filter(item => item.kind === "result").length;
  let text = `Code files:\n${lines.join("\n")}\n\nDocuments:\n${docs.join("\n") || "- none"}`;
  if (tests.length) text += `\n\n${tests.length} test files (${[...new Set(tests.map(item => path.posix.dirname(item.path)))].join(", ")}) are not listed one by one.`;
  if (results) text += `\n${results} result or log files are not listed.`;
  if (history) text += `\n${history} files sit in archive-style folders and are not listed.`;
  if (text.length <= limit) return text;
  // Too big: keep the entry points and the most imported files in full, then count folders.
  const importedBy = new Map();
  for (const item of code) for (const target of item.imports || []) importedBy.set(target, (importedBy.get(target) || 0) + 1);
  const keep = new Set(code.filter(item => item.entry || (importedBy.get(item.path) || 0) >= 2).map(item => item.path));
  const folders = new Map();
  for (const item of code) if (!keep.has(item.path)) folders.set(path.posix.dirname(item.path), (folders.get(path.posix.dirname(item.path)) || 0) + 1);
  const shown = lines.filter((_, i) => keep.has(code[i].path));
  text = `Code files (entry points and widely used files):\n${shown.join("\n")}\n\nOther code, by folder:\n${[...folders].map(([folder, n]) => `- ${folder}/: ${n} files`).join("\n")}\n\nDocuments:\n${docs.slice(0, 60).join("\n")}`;
  return text.slice(0, limit);
}

// Paths the agent read, from the live progress lines ("Reading x") and Codex shell commands.
function readPathsFrom(line, known) {
  const found = [];
  const reading = line.match(/^Reading (.+)$/);
  if (reading && known.has(reading[1].trim())) found.push(reading[1].trim());
  const running = line.match(/^Running: (.+)$/);
  if (running && /\b(cat|sed|head|tail|nl|less|bat|awk)\b/.test(running[1]))
    for (const token of running[1].split(/[\s'"|;<>]+/)) {
      const candidate = token.replace(/^\.\//, "");
      if (known.has(candidate)) found.push(candidate);
    }
  return found;
}

function readingSummary(entries, read) {
  const code = entries.filter(item => item.kind === "code" && !item.history).map(item => item.path);
  const seen = code.filter(file => read.has(file));
  return {read: seen.length, total: code.length, unread: code.filter(file => !read.has(file))};
}

module.exports = {buildIndex, indexText, readPathsFrom, readingSummary, pythonFacts, resolveImport};
