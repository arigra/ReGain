// Every text file in the project is read before the map is built: code, configs, job scripts,
// notebooks, results, archived work and docs. Docs are treated as claims to check against the
// code, never as the source of truth. Readers work in parallel batches, with each file's text in
// the prompt, and each file's note is cached by its contents, so a rebuild rereads only changed files.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {eachLimited} = require("./parallel");

const batchChars = 80000;      // text per reader call (fewer, bigger calls: each call has a fixed cost in time)
const batchFiles = 24;         // files per reader call
const fileChars = {code: 40000, config: 12000, result: 8000, doc: 20000};

// A notebook's cells without their outputs (outputs can hold megabytes of images).
function notebookText(raw) {
  try {
    const nb = JSON.parse(raw);
    return (nb.cells || []).map(cell => {
      const source = [].concat(cell.source || []).join("");
      return cell.cell_type === "code" ? "```python\n" + source + "\n```" : source;
    }).join("\n\n");
  } catch { return raw; }
}

async function fileText(root, item) {
  const raw = await fs.promises.readFile(path.join(root, item.path), "utf8");
  const text = item.path.endsWith(".ipynb") ? notebookText(raw) : raw;
  const limit = fileChars[item.kind] || 20000;
  const cut = text.length > limit ? `${text.slice(0, limit)}\n[cut: showing ${limit.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} characters]` : text;
  return {raw, text: cut};
}

const hash = text => crypto.createHash("sha256").update(text).digest("hex");
const cachePath = root => path.join(root, ".regain", "file-notes.json");

async function loadCache(root) {
  try {
    const cache = JSON.parse(await fs.promises.readFile(cachePath(root), "utf8"));
    return cache && cache.files ? cache : {version: 1, files: {}};
  } catch { return {version: 1, files: {}}; }
}

// Notes saved when every file was read, as {path: note}.
async function savedNotes(root) {
  const cache = await loadCache(root);
  return Object.fromEntries(Object.entries(cache.files).map(([file, entry]) => [file, entry.note]).filter(([, note]) => note));
}

// Groups files into reader calls, keeping each folder's files together.
function makeBatches(items) {
  const batches = [];
  let current = [], size = 0;
  for (const item of [...items].sort((a, b) => a.path.localeCompare(b.path))) {
    if (current.length && (size + item.text.length > batchChars || current.length >= batchFiles)) { batches.push(current); current = []; size = 0; }
    current.push(item);
    size += item.text.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

// deps: {run, prompt(batch) -> request, token, report(text)}. Returns {notes: {path: note}, failed: [paths], read}.
async function readAllFiles(root, index, deps) {
  const cache = await loadCache(root);
  const wanted = index.filter(item => ["code", "config", "result", "doc"].includes(item.kind));
  const todo = [], notes = {};
  for (const item of wanted) {
    const {raw, text} = await fileText(root, item);
    const sha = hash(raw);
    const cached = cache.files[item.path];
    if (cached && cached.sha256 === sha && cached.note) notes[item.path] = cached.note;
    else todo.push({...item, text, sha256: sha});
  }
  let done = wanted.length - todo.length;
  const report = () => deps.report?.(`Reading every file · ${Math.min(done, wanted.length)} of ${wanted.length}`);
  report();
  // A reader sometimes skips a file in its answer: those get a second, smaller round.
  let pendingItems = todo;
  for (let round = 0; round < 2 && pendingItems.length; round++) {
    const missed = [];
    await eachLimited(makeBatches(pendingItems), deps.parallel || 16, deps.token, async (batch, token) => {
      try {
        const result = await deps.run(root, "notes", deps.prompt(batch), token, () => {}, `Reading ${batch.length} files (${batch[0].path.split("/")[0]}…)`);
        const byPath = new Map((result.notes || []).map(note => [note.path, note]));
        for (const item of batch) {
          const note = byPath.get(item.path);
          if (!note) { missed.push(item); continue; }
          notes[item.path] = {role: note.role, details: note.details, decides: note.decides};
          cache.files[item.path] = {sha256: item.sha256, note: notes[item.path]};
          done++;
        }
      } catch (error) {
        if (token?.isCancellationRequested && /cancel/i.test(error.message)) throw error;
        missed.push(...batch);
      }
      report();
    });
    pendingItems = missed;
  }
  const failed = pendingItems.map(item => item.path);
  for (const file of Object.keys(cache.files)) if (!wanted.some(item => item.path === file)) delete cache.files[file];
  await fs.promises.mkdir(path.dirname(cachePath(root)), {recursive: true});
  await fs.promises.writeFile(cachePath(root), JSON.stringify(cache, null, 1) + "\n", "utf8");
  return {notes, failed, read: Object.keys(notes).length, total: wanted.length, reread: todo.length - failed.length};
}

// Notes as prompt text: full notes for the files that matter most here, the role line for the rest.
function notesText(notes, index, {focus = [], limit = 60000} = {}) {
  const order = index.filter(item => notes[item.path]);
  const label = item => item.history ? " (archive)" : item.kind === "doc" ? " (document: a claim, check it against the code)" : item.kind === "result" ? " (result)" : "";
  const full = item => {
    const note = notes[item.path];
    return `- ${item.path}${label(item)}: ${note.role}${note.details ? ` Details: ${note.details}` : ""}${note.decides ? ` Decides: ${note.decides}` : ""}`;
  };
  const short = item => `- ${item.path}${label(item)}: ${notes[item.path].role}`;
  const focused = new Set(focus);
  let lines = order.map(item => (focused.size ? focused.has(item.path) : true) ? full(item) : short(item));
  let text = lines.join("\n");
  if (text.length > limit) {
    lines = order.map(item => focused.has(item.path) ? full(item) : short(item));
    text = lines.join("\n");
  }
  return text.length > limit ? text.slice(0, limit) + "\n[more files not shown]" : text;
}

module.exports = {readAllFiles, notesText, makeBatches, notebookText, fileText, loadCache, savedNotes};
