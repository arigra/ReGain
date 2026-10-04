// Project size, so every agent call spends effort in proportion to the project.
const fs = require("fs");
const path = require("path");
const {skippedDirectories} = require("./file-coverage");

const sourceExtensions = new Set([".py", ".pyx", ".ipynb", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".c", ".cc", ".cpp", ".cxx",
  ".h", ".hh", ".hpp", ".cu", ".cuh", ".java", ".kt", ".scala", ".go", ".rs", ".rb", ".php", ".cs", ".swift", ".m", ".mm",
  ".sh", ".bash", ".zsh", ".ps1", ".lua", ".r", ".jl", ".sql"]);
// Old work still counts as a file, but not toward the size that sets the budget.
const historyDirectories = new Set(["archive", "archived", "legacy", "old", "deprecated", "attic"]);

async function measureProject(root) {
  const size = {files: 0, lines: 0, historyFiles: 0, historyLines: 0};
  async function walk(folder, history) {
    let entries;
    try { entries = await fs.promises.readdir(path.join(root, folder), {withFileTypes: true}); }
    catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relative = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name) && !entry.name.startsWith(".")) await walk(relative, history || historyDirectories.has(entry.name.toLowerCase()));
        continue;
      }
      if (!entry.isFile() || !sourceExtensions.has(path.extname(entry.name).toLowerCase())) continue;
      const stat = await fs.promises.stat(path.join(root, relative));
      if (stat.size > 2 * 1024 * 1024) continue;
      const text = await fs.promises.readFile(path.join(root, relative), "utf8");
      const lines = text.split("\n").length;
      if (history) { size.historyFiles++; size.historyLines += lines; }
      else { size.files++; size.lines += lines; }
    }
  }
  await walk("", false);
  return size;
}

// steps: what the prompt asks for. maxTurns: a hard stop well above that, so a slow run ends instead of hanging.
const tiers = [
  {label: "small", upTo: 15000, subjects: [4, 6], children: [2, 5], steps: {map: 25, branch: 12, detail: 20, review: 12, fix: 6, visual: 8, chat: 10},
    sections: 4, sourcesPerSection: 3, excerptLines: 40, decisions: 8},
  {label: "medium", upTo: 60000, subjects: [5, 8], children: [3, 6], steps: {map: 40, branch: 20, detail: 30, review: 18, fix: 8, visual: 10, chat: 15},
    sections: 5, sourcesPerSection: 3, excerptLines: 50, decisions: 12},
  {label: "large", upTo: Infinity, subjects: [6, 10], children: [3, 8], steps: {map: 60, branch: 30, detail: 40, review: 25, fix: 10, visual: 12, chat: 20},
    sections: 6, sourcesPerSection: 4, excerptLines: 60, decisions: 16},
];

function budgetFor(size) {
  const tier = tiers.find(item => size.lines <= item.upTo);
  const maxTurns = Object.fromEntries(Object.entries(tier.steps).map(([kind, steps]) => [kind, Math.ceil(steps * 2.5)]));
  return {...tier, size, maxTurns};
}

async function projectBudget(root) {
  return budgetFor(await measureProject(root));
}

function budgetText(budget, kind) {
  const {size} = budget;
  const history = size.historyFiles ? ` Another ${size.historyFiles} files (~${size.historyLines.toLocaleString("en-US")} lines) sit in archive-style folders: read their index or README, not their code.` : "";
  return `This project has ${size.files} source files (~${size.lines.toLocaleString("en-US")} lines): a ${budget.label} project.${history} ` +
    `Keep your effort in proportion: aim to finish in about ${budget.steps[kind]} tool steps. Read what decides behavior, and skim or skip generated results, data files and logs.`;
}

// What a guided notebook may hold. The prompts state these and the checks enforce them.
function notebookLimits(budget) {
  return {sections: [3, budget.sections + 1], excerptsPerSection: budget.sourcesPerSection, excerptLines: budget.excerptLines,
    titleWords: 8, verdictWords: [25, 90], headingWords: [2, 7], takeawayWords: 35, bodyWords: 200, noticeWords: 50,
    terms: 8, termWords: 15, unresolved: 6, questionWords: 30, demonstrations: 2, decisions: budget.decisions};
}

module.exports = {measureProject, budgetFor, projectBudget, budgetText, notebookLimits, tiers, sourceExtensions, historyDirectories};
