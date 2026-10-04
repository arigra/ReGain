const {spawn} = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const vscode = require("vscode");
const {projectBudget, budgetText, notebookLimits} = require("./budget");
const {indexText} = require("./project-index");
const {notesText} = require("./file-notes");
const {learnerText} = require("./conversation");
const {describeClaudeEvent, describeCodexEvent, startProgress} = require("./progress");

const string = {type: "string"};
// code: traced through the code. experiment: question, setup, result. status: what is done and open.
const subjectKind = {type: "string", enum: ["code", "experiment", "status"]};
// Where a subject or step stands in the project, as the evidence shows it.
const progressState = {type: "string", enum: ["done", "in_progress", "not_started", "unknown"]};
const flowStep = {type: "object", additionalProperties: false,
  properties: {id: string, label: string, description: string, state: progressState, sources: {type: "array", items: string}},
  required: ["id", "label", "description", "state", "sources"]};
const source = {type: "object", additionalProperties: false, properties: {path: string, reason: string}, required: ["path", "reason"]};
const mapSchema = {
  type: "object", additionalProperties: false,
  properties: {
    projectName: string, summary: string,
    story: {type: "object", additionalProperties: false, properties: {asks: string, done: string, next: string}, required: ["asks", "done", "next"]},
    capabilities: {type: "array", items: {type: "object", additionalProperties: false,
      properties: {id: string, name: string, purpose: string, kind: subjectKind, role: {type: "string", enum: ["flow", "side"]}, state: progressState,
        runtimeStatus: {type: "string", enum: ["runtime", "research", "evaluation", "tooling", "unknown"]},
        sources: {type: "array", items: source},
        flow: {type: "array", items: flowStep},
        related: {type: "array", items: string}},
      required: ["id", "name", "purpose", "kind", "role", "state", "runtimeStatus", "sources", "flow", "related"]}},
    terms: {type: "array", items: {type: "object", additionalProperties: false, properties: {term: string, meaning: string}, required: ["term", "meaning"]}},
    openQuestions: {type: "array", items: string},
    uncertainties: {type: "array", items: string},
  },
  required: ["projectName", "summary", "story", "capabilities", "terms", "openQuestions", "uncertainties"],
};
const branchSchema = {
  type: "object", additionalProperties: false,
  properties: {
    children: {type: "array", items: {type: "object", additionalProperties: false,
      properties: {id: string, name: string, purpose: string, kind: subjectKind, state: progressState,
        runtimeStatus: {type: "string", enum: ["runtime", "research", "evaluation", "tooling", "unknown"]},
        sources: {type: "array", items: source},
        flow: {type: "array", items: {type: "object", additionalProperties: false,
          properties: {id: string, label: string, description: string, state: progressState, sources: {type: "array", items: string}},
          required: ["id", "label", "description", "state", "sources"]}}},
      required: ["id", "name", "purpose", "kind", "state", "runtimeStatus", "sources", "flow"]}},
    uncertainties: {type: "array", items: string},
  }, required: ["children", "uncertainties"],
};
const auditSchema = {
  type: "object", additionalProperties: false,
  properties: {missing: {type: "array", items: {type: "object", additionalProperties: false,
    properties: {name: string, parentId: string, evidencePaths: {type: "array", items: string}},
    required: ["name", "parentId", "evidencePaths"]}}},
  required: ["missing"],
};
const coverageSchema = {
  type: "object", additionalProperties: false,
  properties: {decisions: {type: "array", items: {type: "object", additionalProperties: false,
    properties: {path: string, status: {type: "string", enum: ["supporting", "excluded", "new_feature", "unresolved"]},
      capabilityId: string, featureName: string, reason: string},
    required: ["path", "status", "capabilityId", "featureName", "reason"]}}},
  required: ["decisions"],
};
// A guided notebook, written whole in one call. The agent fills fields, the code lays out the page:
// prose never carries code or headings, and every excerpt is a separate item with its own idea.
const demonstration = {type: "object", additionalProperties: false,
  properties: {title: string, explanation: string, code: string, observation: string, language: {type: "string", enum: ["python", "shell"]}},
  required: ["title", "explanation", "code", "observation", "language"]};
const decision = {type: "object", additionalProperties: false,
  properties: {path: string, line: {type: "integer"}, match: string,
    importance: {type: "string", enum: ["critical", "important", "supporting"]}, why: string},
  required: ["path", "line", "match", "importance", "why"]};
const notebookSchema = {
  type: "object", additionalProperties: false,
  properties: {
    title: string, verdict: string,
    terms: {type: "array", items: {type: "object", additionalProperties: false, properties: {term: string, meaning: string}, required: ["term", "meaning"]}},
    sections: {type: "array", items: {type: "object", additionalProperties: false,
      properties: {heading: string, takeaway: string, body: string,
        excerpts: {type: "array", items: {type: "object", additionalProperties: false,
          properties: {path: string, startLine: {type: "integer"}, endLine: {type: "integer"}, heading: string, notice: string},
          required: ["path", "startLine", "endLine", "heading", "notice"]}},
        demonstrations: {type: "array", items: demonstration}},
      required: ["heading", "takeaway", "body", "excerpts", "demonstrations"]}},
    unresolved: {type: "array", items: string},
    evidence: {type: "array", items: string},
    decisions: {type: "array", items: decision},
  },
  required: ["title", "verdict", "terms", "sections", "unresolved", "evidence", "decisions"],
};
// The reviewer scores the draft against the rubric, lists what it fixed, and returns the improved notebook.
const reviewSchema = {
  type: "object", additionalProperties: false,
  properties: {
    scores: {type: "array", items: {type: "object", additionalProperties: false,
      properties: {criterion: string, score: {type: "integer"}, note: string}, required: ["criterion", "score", "note"]}},
    problems: {type: "array", items: {type: "object", additionalProperties: false,
      properties: {where: string, problem: string, fix: string}, required: ["where", "problem", "fix"]}},
    notebook: notebookSchema,
  },
  required: ["scores", "problems", "notebook"],
};

// A picture of one block's idea: the agent draws the SVG, the code checks it before it is saved.
const visualSchema = {type: "object", additionalProperties: false,
  properties: {title: string, svg: string}, required: ["title", "svg"]};

const listOfStrings = {type: "array", items: string};
const mapChange = {type: "object", additionalProperties: false,
  properties: {op: {type: "string", enum: ["rename", "describe", "merge", "split", "add", "remove", "move", "mark"]},
    id: string, ids: listOfStrings, name: string, purpose: string, kind: subjectKind, state: progressState, sources: listOfStrings, after: string,
    into: {type: "array", items: {type: "object", additionalProperties: false,
      properties: {name: string, purpose: string, kind: subjectKind, sources: listOfStrings}, required: ["name", "purpose", "kind", "sources"]}},
    reason: string},
  required: ["op", "id", "ids", "name", "purpose", "kind", "state", "sources", "after", "into", "reason"]};
const chatSchema = {
  type: "object", additionalProperties: false,
  properties: {reply: string, apply: {type: "array", items: mapChange}, suggest: {type: "array", items: mapChange},
    record: {type: "object", additionalProperties: false, properties: {knows: listOfStrings, cares: listOfStrings, open: listOfStrings}, required: ["knows", "cares", "open"]},
    openQuestions: listOfStrings, facts: listOfStrings},
  required: ["reply", "apply", "suggest", "record", "openQuestions", "facts"],
};
const notesSchema = {
  type: "object", additionalProperties: false,
  properties: {notes: {type: "array", items: {type: "object", additionalProperties: false,
    properties: {path: string, role: string, details: string, decides: string}, required: ["path", "role", "details", "decides"]}}},
  required: ["notes"],
};

function onPath(name) {
  const names = process.platform === "win32" ? [`${name}.exe`] : [name];
  for (const directory of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const filename of names) {
      const candidate = path.join(directory, filename);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* Keep searching. */ }
    }
  }
  return null;
}

function codexExecutable() {
  const extension = vscode.extensions.getExtension("openai.chatgpt");
  if (extension) {
    const platforms = process.platform === "win32" ? ["windows-x86_64"]
      : process.platform === "darwin" ? ["macos-aarch64", "macos-x86_64"] : ["linux-x86_64", "linux-aarch64"];
    for (const platform of platforms) {
      const candidate = path.join(extension.extensionPath, "bin", platform, process.platform === "win32" ? "codex.exe" : "codex");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return onPath("codex");
}

function claudeExecutable() {
  const configured = vscode.workspace.getConfiguration("regain").get("claudeExecutable", "claude");
  if (path.isAbsolute(configured)) {
    try { if (fs.statSync(configured).isFile()) return configured; } catch { /* Missing configured path. */ }
    return null;
  }
  return onPath(configured);
}

// Model for one call. File classification is bulk work, so Claude uses a faster model for it.
function modelFor(provider, kind) {
  const config = vscode.workspace.getConfiguration("regain");
  if (provider === "codex") return config.get("codexModel", "").trim();
  const main = config.get("claudeModel", "sonnet").trim();
  if (kind === "coverage" || kind === "notes") return config.get("claudeFastModel", "haiku").trim() || main;
  return main;
}

let selectedProvider, picking = null;
async function chooseProvider() {
  const codex = codexExecutable();
  const claude = claudeExecutable();
  if (codex && claude) {
    if (!selectedProvider) {
      // Parallel calls share one question instead of each asking.
      picking = picking || Promise.resolve(vscode.window.showQuickPick([
        {label: "Codex", provider: "codex"},
        {label: "Claude Code", provider: "claude"},
      ], {placeHolder: "Choose the AI provider for this ReGain session"}));
      const picked = await picking;
      picking = null;
      if (!picked) throw new Error("Analysis cancelled");
      selectedProvider = picked.provider;
    }
    return {provider: selectedProvider, executable: selectedProvider === "claude" ? claude : codex};
  }
  selectedProvider = undefined;
  if (codex) return {provider: "codex", executable: codex};
  if (claude) return {provider: "claude", executable: claude};
  throw new Error("ReGain needs either the Codex CLI or the Claude Code CLI installed to analyze a project.");
}

const safety = "Do not read secrets, credentials, large datasets, or unrelated external folders. Do not run project code or modify files. Return only the requested JSON object.";
const narrate = "Before each group of tool calls, write one short plain sentence saying what you are checking and why (for example: \"Reading the training loop to see what the model learns from\"). The user watches these sentences as live progress.";
const reader = "The reader knows the project's goal but has lost track of its details.";
// Every name and explanation the user reads: plain but never vague, with concrete facts checked against the source.
const plain = "Names and explanations: use simple, intuitive everyday words. Names are 2-4 words that say what the thing does (\"Fit the simulator to real data\", not \"Establish the real radar reference\"). Say what something does before how. Every explanation must be informative and accurate: state concrete facts the reader can rely on (what goes in, what comes out, real numbers, sizes and file names), each checked against the source. No filler, no hedging sentences, and no jargon a returning developer would have to decode. Explain an unavoidable term in a few words the first time. Never use semicolons or long dashes (em or en dashes as pauses): use a period, a comma, a colon or parentheses instead. Write plain text: no bold, no headings, no tables. Lists use \"- \". Call subjects by their names, never by their ids. When you give a number, say what it means: compared with what, out of how much, or whether it is good.";

// Where a subject sits in the map, so a call neither rediscovers the project nor covers its neighbours.
function placeOf(map, id) {
  const visit = (items, trail) => {
    for (const item of items || []) {
      if (item.id === id) return {node: item, trail, siblings: (items || []).filter(other => other.id !== id)};
      const found = visit(item.children, trail.concat(item));
      if (found) return found;
    }
    return null;
  };
  return visit(map?.capabilities, []);
}

function contextText(map, node) {
  const place = placeOf(map, node.id) || {trail: [], siblings: []};
  const outline = (map?.capabilities || []).map(item => item.name).join(" · ");
  const lines = [`Project: ${map?.summary || "(no summary)"}`, `Top-level subjects: ${outline}.`,
    `This subject: ${place.trail.map(item => item.name).concat(node.name).join(" > ")}.`];
  if (place.siblings.length) lines.push(`Its siblings, covered on their own pages (do not explain them): ${place.siblings.map(item => item.name).join(" · ")}.`);
  return lines.join("\n");
}

const sourceList = node => (node.sources || []).map(item => item.path).join(", ");

const truth = "Every claim comes from the code, configs, scripts and result files. Docs and READMEs were written along the way, often by agents, so treat them as claims: use them for intent and history, check them against the code, and when they disagree with the code, trust the code and raise the difference as an open question.";

// One reader call: the text of a batch of files is in the prompt, so no tools are needed.
function notesPrompt(batch, projectName) {
  const files = batch.map(item => `=== FILE: ${item.path}${item.history ? " (archive)" : ""} ===\n${item.text}`).join("\n\n");
  // Short instructions and light thinking: these calls only summarize the text they are given.
  // No hidden thinking either: it cost 8,000+ tokens per call for notes of about 100 words, with no better notes.
  return {maxTurns: 4, noTools: true, effort: "low", thinking: 0, systemPrompt: "You read project files and write short, accurate notes about each one. Answer only with the requested structured output.",
    text: `You are reading every file of the project "${projectName}" so that ReGain understands it from the files themselves, not from its docs. Below is the full text of ${batch.length} files. Write one note per file, with its exact path.
- role: 1-2 sentences on what the file does and where it fits (what calls it or reads it, what it produces).
- details: the concrete facts someone needs (main functions or settings, defaults, shapes, sizes, numbers, results), at most 60 words.
- decides: the choices in this file that change results (thresholds, defaults, formulas, flags), at most 30 words, or empty.
For a doc, say what it claims. For a result file, say what was measured and the key numbers. For a config, say what it sets up and the values that matter.
Use only what is in the text below. Do not run or open anything.
${plain}

${files}`};
}

async function mapPrompt(root, index, notes) {
  const budget = await projectBudget(root);
  const [low, high] = budget.subjects;
  const read = notes && Object.keys(notes).length;
  const files = read
    ? `\nEvery file in the project has already been read for you. Here is a note on each one (what it does, the facts that matter, what it decides):\n${notesText(notes, index)}\n\nIndex of the code (definitions, project imports, entry points):\n${indexText(index, 12000)}\n\nWork from these notes and open a file only to check something they leave unclear.`
    : index ? `\nHere is an index of every file in the project (definitions, project imports, entry points). Use it to see the whole structure, so no part of the project is missed, and open the files that decide behavior:\n${indexText(index)}\n` : "";
  return {maxTurns: budget.maxTurns.map, budget, text: `Build the top-level map of this repository for ReGain. ${reader} The map is the first thing they see, so it must tell the project's story at a glance.
${budgetText(budget, "map")}${files}
${truth}
Rules for the map:
- Return ${low}-${high} top-level subjects, all on one axis: the project's main flow or story (input -> processing -> output, or the steps of a study). Cross-cutting concerns such as visualization, orchestration or utilities are not subjects. Describe them inside the subject they serve.
- Order subjects in the order a newcomer should read them, which follows that flow, current work before old work. Put superseded, archived or abandoned work into one final subject (for example "Earlier work").
- Every feature belongs to exactly one subject. Link subjects with related ids and never list a feature twice.
- Give each subject a kind: "code" (something the project does, understood by tracing code), "experiment" (a study: question, setup, result) or "status" (where the project stands: what is done, what is open).
- Give each subject a role: "flow" for the steps of the main pipeline or story, drawn as boxes joined by arrows, or "side" for context around it (the research question, earlier work, shared tools).
- If the project is research, make the first subject a "status" subject about the research question and where it stands, built from results and code.
- Give each subject and each of its steps a state: "done", "in_progress", "not_started" or "unknown", decided from evidence (result files, logs, saved outputs, code that exists or is missing). Use "unknown" when the files cannot tell, for example a long run whose result is not saved.
- Ignore the .regain folder. It belongs to ReGain.
- summary: two or three plain sentences on what the project is for and how far it has got.
- story: three short lines of at most 25 words each. asks: what the project tries to find out or do. done: what is finished so far, with the key result. next: what comes next or is still open.
- terms: 4-10 words or names a returning developer may not recall (project names, datasets, models, methods), each with a meaning of at most 15 plain words. Use these words consistently.
- openQuestions: 0-5 plain questions that the files cannot settle, each at most 20 words, such as whether a long run finished or which of two conflicting values is current. Ask what the user might know.
For each subject give a stable id, a short plain name, a one-or-two sentence purpose, an ordered flow of 2-6 steps, and only the key project-relative source paths that back it (about 8 at most). Put technical doubts in uncertainties.
${plain}
${narrate}
${safety}`};
}

async function branchPrompt(root, map, node) {
  const budget = await projectBudget(root);
  const [low, high] = budget.children;
  return {maxTurns: budget.maxTurns.branch, budget, text: `Split one subject of a ReGain map into its parts: "${node.name}" (kind: ${node.kind || "code"}). Purpose: ${node.purpose}
${contextText(map, node)}
${budgetText(budget, "branch")}
Return ${low}-${high} children that together explain this subject. ${reader} Split by parts a person can understand on their own (a behavior, a step, a decision), not by files or folders. Small variants and options go into a purpose, not into separate children. Give each child a kind (code, experiment or status), a one-or-two sentence purpose, a short ordered flow, and only its own key sources (about 6 at most) plus at most two shared sources it cannot be understood without. If the subject has no meaningful split, return an empty children array. Do not invent features.
Start from these sources: ${sourceList(node)}.
${plain}
${narrate}
${safety}`};
}

// Notes for a subject's own files (full) and the rest (one line each), when every file was read.
const notesFor = (context, files) => context?.notes && Object.keys(context.notes).length
  ? `\nNotes from reading every file (full for this subject's files, one line for the rest). Use them to avoid rereading, and open files for exact lines:\n${notesText(context.notes, context.index || [], {focus: files, limit: 30000})}\n` : "";

// What makes a notebook great. The writer checks itself against it, the reviewer scores and fixes against it.
const rubric = [
  ["Verdict first", "The verdict answers the subject's question in its first sentence, then gives the key numbers and the single biggest caveat. A reader who stops after it knows where things stand."],
  ["One story", "Sections follow one line of thought. When a later finding weakens an earlier one (a check that questions a gain, a run that never finished), the verdict says so and the earlier section points to it."],
  ["Headings name ideas", "Every section and excerpt heading says what happens or what it shows. Never a file name, never repeated on the page."],
  ["Nothing twice", "Each section, excerpt and open question adds something new. No paragraph restates another and no open question appears twice."],
  ["Numbers mean something", "Every number says what it is compared with, out of how much, or whether it is good, and matches the file it comes from."],
  ["Terms explained", "Every term a returning developer may not know is in terms or explained in a few words where it first appears."],
  ["Excerpts earn their place", "Each excerpt shows the lines that do the work, and its notice points at a specific line or value and says why it matters."],
  ["Readable", "Plain sentences with one idea each, no chains of jargon, within the length limits."],
  ["Accurate", "Every claim checks out against the code, configs and result files."],
  ["Open questions are real", "Each is specific, answerable by the user or by a run, and not already answered on the page."],
];
const rubricText = rubric.map(([name, rule], i) => `${i + 1}. ${name}: ${rule}`).join("\n");

function fieldsText(limits) {
  return `How to fill each field:
- title: the subject's question or job in plain words, at most ${limits.titleWords} words ("Does blending clips help?", "Turn recordings into training maps").
- verdict: 2-4 sentences, ${limits.verdictWords[0]}-${limits.verdictWords[1]} words. The first sentence answers the question (for code: what goes in and what comes out). Then the key numbers with what they are compared with. Then the biggest caveat or what is still open.
- terms: 0-${limits.terms} words the reader may not recall, each meaning at most ${limits.termWords} plain words. Skip words explained in the prose.
- sections: ${limits.sections[0]}-${limits.sections[1]} in reading order. heading: ${limits.headingWords[0]}-${limits.headingWords[1]} words naming the idea. takeaway: one sentence, at most ${limits.takeawayWords} words, the fact to remember from this section. body: 2-5 sentences, at most ${limits.bodyWords} words, building on the takeaway without repeating it.
- excerpts: 0-${limits.excerptsPerSection} per section, each ${limits.excerptLines} lines at most, with startLine and endLine checked by reading the file. heading names what the lines do (never the file name). notice: 1-2 sentences, at most ${limits.noticeWords} words, pointing at a specific line or value and saying why it matters. The same lines never appear twice on the page. A result file is a good excerpt when its numbers are the point.
- demonstrations: at most ${limits.demonstrations} on the whole page, only when a small safe example shows something reading cannot, using the real API with current signatures. Never training, never large data. Otherwise empty.
- unresolved: 0-${limits.unresolved} open questions for the whole page, each at most ${limits.questionWords} words, each asked once.
- evidence: the files the page's numbers come from that are not already excerpts.
- decisions: at most ${limits.decisions} lines that most change the outcome, with exact line text in match, one-based line number, a critical/important/supporting rating and a specific reason.
Prose fields (verdict, takeaway, body, notice, meanings) are plain sentences: no code blocks, no headings, no tables, no "Source:" lines. Code belongs in excerpts.`;
}

let exampleCache;
function exampleText() {
  if (!exampleCache) exampleCache = fs.readFileSync(path.join(__dirname, "examples", "notebook-example.json"), "utf8").trim();
  return exampleCache;
}
const exampleBlock = () => `An example of a great notebook from a different project. Copy its shape and style (verdict first, ideas as headings, a takeaway per section, notices that point at lines). Never copy its content:\n${exampleText()}`;

const pathShapes = {
  code: "Sections follow the order data moves through this part: the first starts from what goes in, the last ends with what comes out and where it goes next.",
  experiment: "Sections: the question, the setup (data, arms, and the rule decided beforehand), the result and verdict, then what it means and its caveats. Quote numbers exactly as the result files give them.",
  status: "Sections: one per milestone, each saying what was done, its verdict or state, and what is still open.",
};

// "Create notebook": the whole guided notebook in one call. A review call and the code's checks follow.
async function detailPrompt(root, map, node, learner, context = {}) {
  const budget = await projectBudget(root);
  const limits = notebookLimits(budget);
  const kind = pathShapes[node.kind] ? node.kind : "code";
  const children = (node.children || []).map(item => item.name);
  const parts = children.length ? `\nThis subject has parts with their own pages: ${children.join(" · ")}. Show how they fit together, one section per part at most, without explaining their insides.` : "";
  return {maxTurns: budget.maxTurns.detail, budget, text: `Write a guided ReGain notebook for one subject: "${node.name}" (kind: ${kind}). Purpose: ${node.purpose}
${contextText(map, node)}${parts}
${reader} The notebook takes them from not knowing where this subject stands to understanding it well enough to change it, in about ten minutes of reading. It is the whole page: there is no shorter or longer version.
Work in this order:
1. Read the sources, and the result files when there are any.
2. Decide the one thing the reader must leave with. That is the verdict. If a check or a later result weakens the main result, that belongs in the verdict too.
3. Plan the sections so they tell that story in order. ${pathShapes[kind]}
4. Pick the excerpts: the few lines in each section that do the work.
5. Write, then check every field against the rubric and the limits, and fix what fails before you answer.
${truth}${notesFor(context, (node.sources || []).map(item => item.path))}
${learnerText(learner)}
Skip what the user already knows and lean toward what they care about.
${budgetText(budget, "detail")}
The rubric:
${rubricText}
${fieldsText(limits)}
${exampleBlock()}
Start from these sources: ${sourceList(node)}.
${plain}
${narrate}
${safety}`};
}

const findingsText = findings => [
  findings.errors.length ? `Hard errors the code found (each must be fixed):\n${findings.errors.map(item => `- ${item}`).join("\n")}` : "The code found no hard errors.",
  findings.warnings.length ? `Warnings the code found (fix each, or keep it only when it is right, for example a number derived from cited numbers that the text says how it was derived):\n${findings.warnings.map(item => `- ${item}`).join("\n")}` : "",
].filter(Boolean).join("\n");

// The editor: scores the draft against the rubric, checks it against the files, returns it improved.
async function reviewPrompt(root, map, node, draft, findings) {
  const budget = await projectBudget(root);
  const limits = notebookLimits(budget);
  return {maxTurns: budget.maxTurns.review, budget, text: `You are the editor of a guided ReGain notebook about "${node.name}". Purpose: ${node.purpose}
${contextText(map, node)}
${reader} Another agent wrote the draft below. Your job is to make it great, not to approve it.
1. Score the draft on each rubric criterion from 1 (fails) to 5 (excellent), with a one-sentence note on why.
2. Check its claims and numbers against the files. Open the excerpts' files and the evidence files, and any file a claim depends on.
3. List every problem you found: where it is (section heading or field), what is wrong, and what you changed.
4. Return the whole improved notebook in notebook: fix every problem and every hard error, keep what is already good, and stay within the limits. Do not shorten good content to save effort.
The questions a reader asks of a weak notebook: what is the answer? Why should I believe it? What is this heading about? Have I read this already? What does this number mean? What is this word?
${findingsText(findings)}
${truth}
${budgetText(budget, "review")}
The rubric:
${rubricText}
${fieldsText(limits)}
${exampleBlock()}
The draft:
${JSON.stringify(draft, null, 1)}
${plain}
${narrate}
${safety}`};
}

// Last pass when hard errors remain: fix exactly those, change nothing else.
async function fixPrompt(root, notebook, findings) {
  const budget = await projectBudget(root);
  const limits = notebookLimits(budget);
  return {maxTurns: budget.maxTurns.fix, budget, text: `The guided ReGain notebook below breaks hard rules. Return it whole with exactly these problems fixed and nothing else changed. Open a file only to correct a line range.
${findingsText({errors: findings.errors, warnings: []})}
${fieldsText(limits)}
The notebook:
${JSON.stringify(notebook, null, 1)}
${plain}
${safety}`};
}

// "Draw a visual" beside a block: one picture of the idea in those lines, not of the code's text.
const visualColors = "Colors: background #f8fafb filling the whole viewBox (a rect drawn first, rounded corners 12), text #1d2733, muted text #5b6b78, lines #8a9aa6, and accents #1a8f8a (teal), #c77d12 (amber), #6b5bd2 (violet), #c2413a (red, only for warnings or uncertain parts).";
async function visualPrompt(root, {pageTitle, pageText, target, code}) {
  const budget = await projectBudget(root);
  // A small thinking budget: unbounded, it spent 7 of 10 minutes planning one picture. With none, labels overlapped.
  return {maxTurns: budget.maxTurns.visual, budget, effort: "medium", thinking: 4000, text: `Draw one picture that explains the idea in ${target}, for a ReGain guide called "${pageTitle}". ${reader} The picture should let them see in five seconds what these lines do and why, so they can come back to it later or explain it to someone else.
What the guide says around this block:
${pageText || "(nothing)"}
${code ? `The block's lines:\n${code}\n` : ""}
Open other files only when the picture depends on them (a called function, a result file with the real numbers). Do not plan at length: sketch the layout in a sentence or two, then draw. Then choose the one form that shows the idea best:
- data moving through steps: boxes and arrows, each arrow labelled with what passes along it and its shape (for example "16 x 64 x 64 maps")
- a rule or decision: the inputs, the test with its real threshold, and what each outcome leads to
- a structure: the parts and how they nest or connect
- a comparison or a result: the real numbers from the files, drawn to scale
Use real names, sizes, thresholds and numbers from the code and result files. Never invent values. Draw a small worked example when it makes the idea click. Mark anything you are not sure about with a dashed red outline and a "?".
Keep it simple: at most about 12 labelled parts, labels of 1-5 plain words, no code text except short names. Font: system-ui, at least 13px, titles 16px bold.
Layout: work out each element's x and y before writing it. Text never overlaps other text, bars or lines: leave at least 8px around every label, put bar values beside or above the bar, and keep each label inside its box. Bars and numbers are drawn to scale from 0.
title: the idea in these lines in 3-8 plain words (not the guide's title). Use it as the picture's heading too.
svg: one complete, self-contained SVG document: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 W H"> with W between 480 and 960. No scripts, no event handlers, no external links or images, no foreignObject. Put the title in a <title> element.
${visualColors}
${truth}
${budgetText(budget, "visual")}
${plain}
${narrate}
${safety}`};
}

// One message in the overview conversation (or the opening message when there are no messages yet).
async function chatPrompt(root, map, {messages: all, learner, selected, index, notes, progress}) {
  const budget = await projectBudget(root);
  const messages = (all || []).filter(m => m.status !== "error");
  const [low, high] = budget.subjects;
  const subjects = (map.capabilities || []).map(item => `- id ${item.id} · ${item.name} (${item.kind || "code"}): ${item.purpose} Files: ${(item.sources || []).map(s => s.path).slice(0, 8).join(", ")}`).join("\n");
  const history = (messages || []).slice(-10).map(m => `${m.role === "user" ? "User" : "ReGain"}: ${m.text}`).join("\n");
  const reading = map.reading ? (map.reading.read >= map.reading.total ? `Every file was read before the map was built (${map.reading.total} files).` : `Before the map was built, ${map.reading.read} of ${map.reading.total} files were read. Not read: ${map.reading.unread.slice(0, 40).join(", ")}.`) : "";
  const opening = !(messages || []).length;
  const names = ids => (ids || []).map(id => (map.capabilities || []).find(item => item.id === id)?.name).filter(Boolean);
  const path = progress ? [names(progress.covered).length ? `The user has gone through: ${names(progress.covered).join(" · ")}.` : "", names(progress.started).length ? `The user has started the guides for: ${names(progress.started).join(" · ")}.` : ""].filter(Boolean).join("\n") : "";
  const questions = (map.openQuestions || []).length ? `Open questions shown on the page:\n${map.openQuestions.map(q => `- ${q}`).join("\n")}` : "There are no open questions on the page.";
  const task = opening
    ? `Open the conversation. The page already shows the summary and the subjects as numbered boxes in reading order, so do not repeat the summary or list the subjects. In 2-4 simple sentences, tell the project's story in your own words: why it exists and how its parts lead into each other. Then say in one sentence why the subjects are split this way, and point to where to start. A project of this size usually needs ${low}-${high} subjects. If the current subjects are too many, too few, badly named or overlapping, propose the better set: put those changes in suggest, not apply. End by inviting the user to ask anything or say what to merge, split, add or drop. Do not ask how familiar they are with the project. Work from the subjects and the notes, and open a file only to settle something that is genuinely unclear.`
    : `Answer the user's last message. Reply in 2-4 plain sentences, one topic at a time, never a quiz. Decide yourself whether you need to read code to answer accurately, and read it when you do. If the user asked for a change to the subjects, put it in apply. Changes you think would help but the user did not ask for go in suggest. A project of this size usually needs ${low}-${high} subjects, so steer toward that, but the user decides. If the user answers an open question or tells you a fact about the project (for example that a run finished), put that fact in facts, drop the question from openQuestions, and if it changes where a subject stands, add a mark change to apply.`;
  return {maxTurns: budget.maxTurns.chat, budget, text: `You are ReGain's guide, talking with the user about the overview of this project, so that together you settle its main subjects. ${reader}
Project: ${map.summary}
Current subjects:
${subjects}
${selected ? `The user has this subject selected on the map: ${selected.name} (id ${selected.id}).` : ""}
${reading}
${questions}
${path}
${learnerText(learner)}
${history ? `Conversation so far:\n${history}` : ""}
${notes && Object.keys(notes).length ? `Notes from reading every file:\n${notesText(notes, index || [], {focus: selected ? (selected.sources || []).map(item => item.path) : [], limit: 25000})}` : index ? `Index of every file in the project:\n${indexText(index, 9000)}` : ""}
${truth}
${budgetText(budget, "chat")}
${task}
Map changes: rename (id, name), describe (id, purpose), merge (ids, name, purpose), split (id, into: new subjects each with name, purpose, kind and real files), add (name, purpose, kind, real files, after: id or empty), remove (id), move (id, after: id or empty for first), mark (id, state: where the subject stands now). Fill unused fields with empty values.
openQuestions: the full updated list of open questions (keep the ones still open, add new ones the conversation raised). facts: only new facts the user told you in their last message, each in one short plain sentence, or empty. Every change carries a short plain reason. Use only ids from the list above and only files that exist.
record: the full updated lists, in short phrases of at most 8 words. knows: only what the user said or clearly showed they understand, not everything you explained. cares: what the user asked about or said matters to them. open: questions the user raised that are not answered yet. Keep earlier entries unless the user corrected them.
${plain}
${narrate}
${safety}`};
}

function auditPrompt(map) {
  const outline = map.capabilities.map(parent => ({id: parent.id, name: parent.name,
    children: (parent.children || []).map(child => child.name)}));
  return `Independently audit this ReGain capability tree against the repository source. Search public output fields, configuration, feature-specific classes and functions, tests, and design documentation for named user-visible behaviors. Return only important behaviors that are absent by name and meaning from the tree; do not list implementation helpers, synonyms, or already represented features. For each omission, identify the existing top-level parent id where it belongs and cite exact project-relative source paths. Investigate beyond the tree's initially cited files. An omitted behavior may be hidden in a shared orchestrator. Do not read secrets, credentials, large datasets, or unrelated external folders. Do not run project code or modify files. Return only the requested JSON object. Current tree: ${JSON.stringify(outline)}.`;
}

const schemaFor = kind => kind === "map" ? mapSchema : kind === "branch" ? branchSchema : kind === "chat" ? chatSchema : kind === "review" ? reviewSchema : kind === "visual" ? visualSchema : kind === "notes" ? notesSchema
  : kind === "audit" ? auditSchema : kind === "coverage" ? coverageSchema : notebookSchema;
const titles = {notes: "Reading files", map: "Building the project map", branch: "Splitting a subject", detail: "Writing a notebook", review: "Reviewing a notebook", visual: "Drawing a visual", fix: "Fixing a notebook", chat: "Answering", audit: "Checking the map", coverage: "Classifying files"};

// prompt: a string, or {text, maxTurns, budget} from the prompt builders above.
async function run(root, kind, prompt, token, onProgress, title = titles[kind] || "ReGain agent") {
  const request = typeof prompt === "string" ? {text: prompt} : prompt;
  const choice = await chooseProvider();
  const model = modelFor(choice.provider, kind);
  const progress = startProgress(`${title} · ${choice.provider === "claude" ? "Claude Code" : "Codex"}${model ? ` (${model})` : ""}`, onProgress, {onStep: request.onStep});
  const stats = {};
  try {
    const result = choice.provider === "claude"
      ? await runClaude(root, kind, request, token, progress, choice.executable, model, stats)
      : await runCodex(root, kind, request, token, progress, choice.executable, model, stats);
    const ms = progress.finish(`Done${stats.turns ? ` in ${stats.turns} turns` : ""}${stats.costUsd ? `, $${stats.costUsd.toFixed(2)}` : ""}`);
    await recordRun(root, {kind, title, provider: choice.provider, model, ms, ok: true, ...stats, size: request.budget?.size});
    return result;
  } catch (error) {
    const ms = progress.finish(`Stopped: ${error.message}`);
    await recordRun(root, {kind, title, provider: choice.provider, model, ms, ok: false, error: error.message, ...stats, size: request.budget?.size});
    throw error;
  }
}

// One line per agent call, so time and cost can be compared across projects.
async function recordRun(root, entry) {
  try {
    await fs.promises.mkdir(path.join(root, ".regain"), {recursive: true});
    await fs.promises.appendFile(path.join(root, ".regain", "agent-runs.jsonl"), JSON.stringify({at: new Date().toISOString(), ...entry}) + "\n", "utf8");
  } catch { /* A missing log must not fail the analysis. */ }
}

function runCodex(root, kind, request, token, progress, executable, model, stats) {
  return (async () => {
    const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), "regain-schema-"));
    const schemaPath = path.join(temporary, "output.schema.json");
    await fs.promises.writeFile(schemaPath, JSON.stringify(schemaFor(kind)), "utf8");
    try {
      return await new Promise((resolve, reject) => {
        // File readers only summarize the text they are given: light reasoning keeps them quick.
        const child = spawn(executable, ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--json", "--output-schema", schemaPath,
          ...(request.effort || request.noTools ? ["-c", `model_reasoning_effort="${request.effort || "low"}"`] : []), ...(model ? ["--model", model] : []), "-C", root, "-"],
          {cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]});
        let finalText = "", errorText = "", failure = "", cancelled = false;
        const cancellation = token?.onCancellationRequested(() => { cancelled = true; child.kill(); });
        child.stdin.on("error", () => {});
        child.stderr.on("data", chunk => { errorText = (errorText + chunk.toString()).slice(-4000); });
        readline.createInterface({input: child.stdout}).on("line", line => {
          let event;
          try { event = JSON.parse(line); } catch { return; }
          for (const text of describeCodexEvent(event)) progress.step(text);
          if (event.type === "item.completed" && event.item?.type === "agent_message") finalText = event.item.text || "";
          if (event.type === "turn.failed") failure = event.error?.message || "Agent turn failed";
          if (event.type === "turn.completed") {
            stats.inputTokens = event.usage?.input_tokens;
            stats.outputTokens = event.usage?.output_tokens;
            progress.note("Checking the agent's answer…");
          }
        });
        child.on("error", error => { cancellation?.dispose(); reject(error); });
        child.on("close", code => {
          cancellation?.dispose();
          if (cancelled) return reject(new Error("Analysis cancelled"));
          if (code !== 0 || failure) return reject(new Error(failure || errorText || `Codex exited with code ${code}`));
          try { resolve(JSON.parse(finalText)); }
          catch { reject(new Error("Codex returned invalid structured analysis")); }
        });
        child.stdin.end(request.text);
      });
    } finally {
      await fs.promises.rm(temporary, {recursive: true, force: true});
    }
  })();
}

function runClaude(root, kind, request, token, progress, executable, model, stats) {
  return new Promise((resolve, reject) => {
    // Isolated from the user's own Claude Code setup: no plugins, hooks, skills or extra tool servers,
    // which otherwise load into every call and slow it down. Chat answers think less, to stay quick.
    const child = spawn(executable, ["-p", "--output-format", "stream-json", "--verbose", "--json-schema", JSON.stringify(schemaFor(kind)),
      // File readers get the text in the prompt: no tools at all, and no read-only mode (it confuses a call with nothing to read).
      // Everyone else gets read-only tools. Plan mode was read-only too, but agents then wrote their answer
      // into a plan, asked to leave plan mode, and wrote it again: a visual took 4.5 minutes that way.
      ...(request.noTools ? ["--tools", ""] : ["--tools", "Read,Grep,Glob"]),
      ...(request.systemPrompt ? ["--system-prompt", request.systemPrompt] : []),
      ...(request.thinking !== undefined ? ["--max-thinking-tokens", String(request.thinking)] : []),
      "--no-session-persistence", "--setting-sources", "", "--disable-slash-commands", "--strict-mcp-config",
      ...(request.effort ? ["--effort", request.effort] : kind === "chat" ? ["--effort", "medium"] : []), ...(request.maxTurns ? ["--max-turns", String(request.maxTurns)] : []),
      ...(model ? ["--model", model] : [])],
    {cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]});
    let result = null, errorText = "", cancelled = false, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cancellation?.dispose();
      if (error) reject(error); else resolve(value);
    };
    const cancellation = token?.onCancellationRequested(() => { cancelled = true; child.kill(); });
    child.stdin.on("error", () => {});
    child.stderr.on("data", chunk => { errorText = (errorText + chunk.toString()).slice(-4000); });
    readline.createInterface({input: child.stdout}).on("line", line => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === "result") { result = event; return; }
      for (const text of describeClaudeEvent(event, root)) progress.step(text);
    });
    child.on("error", error => finish(error.code === "ENOENT"
      ? new Error("Claude Code CLI was not found. Install it or set ReGain: Claude Executable to its path.") : error));
    child.on("close", code => {
      if (cancelled) return finish(new Error("Analysis cancelled"));
      if (result) Object.assign(stats, {turns: result.num_turns, costUsd: result.total_cost_usd, agentMs: result.duration_ms,
        inputTokens: (result.usage?.input_tokens || 0) + (result.usage?.cache_read_input_tokens || 0) + (result.usage?.cache_creation_input_tokens || 0),
        outputTokens: result.usage?.output_tokens});
      if (result?.subtype === "error_max_turns")
        return finish(new Error(`The agent used its whole allowance of ${request.maxTurns} steps without finishing. Try again, and if it happens again, split this subject first.`));
      if (!result) return finish(new Error(errorText || `Claude Code exited with code ${code}`));
      if (result.is_error || String(result.subtype || "").startsWith("error"))
        return finish(new Error(result.result || errorText || "Claude Code analysis failed"));
      if (!result.structured_output || typeof result.structured_output !== "object")
        return finish(new Error("Claude Code returned no structured analysis"));
      progress.note("Checking the agent's answer…");
      finish(null, result.structured_output);
    });
    child.stdin.end(request.text);
  });
}

module.exports = {run, recordRun, modelFor, notesPrompt, mapPrompt, branchPrompt, auditPrompt, detailPrompt, reviewPrompt, fixPrompt, visualPrompt, rubric, chatPrompt, notesSchema, mapSchema, branchSchema, chatSchema, notebookSchema, reviewSchema, visualSchema, auditSchema, coverageSchema};
