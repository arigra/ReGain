// A guided notebook: one agent writes it whole, a second agent reviews and improves it against the
// rubric, the code checks the hard rules in between, and only the code lays out the page.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {detailPrompt, reviewPrompt, fixPrompt} = require("./agent-runner");
const {projectBudget, notebookLimits} = require("./budget");
const {tidy, sourcePath} = require("./semantic-map");

// Prose is tidied (no semicolons or long dashes) but never cut: a field that is too long is an error to fix, not to trim.
const prose = value => tidy(String(value || "").trim());
const oneLine = value => prose(value).replace(/\s*\r?\n\s*/g, " ");
const words = value => String(value || "").trim().split(/\s+/).filter(Boolean).length;
const list = value => Array.isArray(value) ? value : [];

// Numbers a reader might check: anything with a decimal point, or whole numbers from 100 up.
// Line numbers ("line 21", "lines 116-155") are not claims.
function claimedNumbers(value) {
  const textOnly = String(value || "").replace(/\blines?\s+\d+(\s*(-|to|through|and)\s*\d+)?/gi, " ");
  return (textOnly.match(/(?<![\w.])\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\w])|(?<![\w.])\d+(?:\.\d+)?(?![\w])/g) || [])
    .filter(item => item.includes(".") || Number(item.replace(/,/g, "")) >= 100);
}
function fileNumbers(contents) {
  return (contents.replace(/(\d)_(?=\d)/g, "$1").match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/gi) || []).map(Number).filter(Number.isFinite);
}
function backed(claim, pool) {
  const value = Number(claim.replace(/,/g, ""));
  const places = (claim.split(".")[1] || "").length;
  const round = x => Number(x.toFixed(places));
  return pool.some(x => [Math.abs(x), Math.abs(x) * 100].some(y => Math.abs(round(y) - value) < 1e-9));
}

const similar = (a, b) => {
  const set = value => new Set(String(value).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length > 3));
  const x = set(a), y = set(b);
  if (!x.size || !y.size) return false;
  const shared = [...x].filter(w => y.has(w)).length;
  return shared / Math.min(x.size, y.size) >= 0.75;
};
const looksLikeFile = heading => /\.[a-z]{1,5}\b/i.test(heading) || /[\\/]/.test(heading);

// The hard rules (errors, which must be fixed) and the soft ones (warnings, for the reviewer to judge).
async function checkNotebook(root, notebook, limits) {
  const errors = [], warnings = [];
  const nb = notebook || {};
  const sections = list(nb.sections);
  const over = (label, value, max) => { if (words(value) > max) errors.push(`${label} has ${words(value)} words, the limit is ${max}.`); };

  if (!String(nb.title || "").trim()) errors.push("The title is empty.");
  over("The title", nb.title, limits.titleWords);
  const verdictWords = words(nb.verdict);
  if (verdictWords < limits.verdictWords[0] || verdictWords > limits.verdictWords[1])
    errors.push(`The verdict has ${verdictWords} words. It needs ${limits.verdictWords[0]}-${limits.verdictWords[1]}.`);
  if (sections.length < limits.sections[0] || sections.length > limits.sections[1])
    errors.push(`The page has ${sections.length} sections. It needs ${limits.sections[0]}-${limits.sections[1]}.`);
  if (list(nb.terms).length > limits.terms) errors.push(`There are ${list(nb.terms).length} terms, the limit is ${limits.terms}.`);
  for (const term of list(nb.terms)) over(`The meaning of "${term.term}"`, term.meaning, limits.termWords);

  const headings = new Map(), excerpts = [];
  const seeHeading = (heading, where) => {
    const key = String(heading || "").trim().toLowerCase();
    if (!key) return errors.push(`${where} has no heading.`);
    if (looksLikeFile(heading)) errors.push(`${where} is headed "${heading}", which is a file name. Name the idea instead.`);
    if (headings.has(key)) errors.push(`The heading "${heading}" is used twice (${headings.get(key)} and ${where}).`);
    else headings.set(key, where);
    const count = words(heading);
    if (count < limits.headingWords[0] || count > limits.headingWords[1]) warnings.push(`${where} heading "${heading}" has ${count} words, aim for ${limits.headingWords[0]}-${limits.headingWords[1]}.`);
  };
  const proseFields = [["The verdict", nb.verdict]];
  let demonstrations = 0;
  for (const [i, section] of sections.entries()) {
    const where = `Section ${i + 1} ("${section.heading || ""}")`;
    seeHeading(section.heading, where);
    if (!String(section.takeaway || "").trim()) errors.push(`${where} has no takeaway.`);
    if (!String(section.body || "").trim()) errors.push(`${where} has no body.`);
    over(`${where} takeaway`, section.takeaway, limits.takeawayWords);
    over(`${where} body`, section.body, limits.bodyWords);
    if (similar(section.takeaway, String(section.body || "").split(/(?<=\.)\s/)[0] || "")) warnings.push(`${where}: the body's first sentence repeats the takeaway.`);
    proseFields.push([`${where} takeaway`, section.takeaway], [`${where} body`, section.body]);
    if (list(section.excerpts).length > limits.excerptsPerSection) errors.push(`${where} has ${section.excerpts.length} excerpts, the limit is ${limits.excerptsPerSection}.`);
    demonstrations += list(section.demonstrations).length;
    for (const [j, excerpt] of list(section.excerpts).entries()) {
      const at = `${where}, excerpt ${j + 1}`;
      seeHeading(excerpt.heading, at);
      over(`${at} notice`, excerpt.notice, limits.noticeWords);
      if (!String(excerpt.notice || "").trim()) errors.push(`${at} has no notice.`);
      proseFields.push([`${at} notice`, excerpt.notice]);
      const file = await sourcePath(root, excerpt.path);
      if (!file) { errors.push(`${at} points at "${excerpt.path}", which is not a file in the project.`); continue; }
      const count = (await fs.promises.readFile(path.join(root, file), "utf8")).split(/\r?\n/).length;
      const lo = Number(excerpt.startLine), hi = Number(excerpt.endLine);
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1 || hi < lo) { errors.push(`${at} has an invalid line range ${excerpt.startLine}-${excerpt.endLine}.`); continue; }
      if (hi > count) errors.push(`${at} ends at line ${hi}, but ${file} has ${count} lines.`);
      if (hi - lo + 1 > limits.excerptLines) errors.push(`${at} is ${hi - lo + 1} lines long, the limit is ${limits.excerptLines}.`);
      const twin = excerpts.find(other => other.file === file && lo <= other.hi && hi >= other.lo);
      if (twin) errors.push(`${at} shows ${file} lines ${lo}-${hi}, which overlap lines ${twin.lo}-${twin.hi} already shown in ${twin.at}.`);
      excerpts.push({file, lo, hi, at});
    }
  }
  if (demonstrations > limits.demonstrations) errors.push(`The page has ${demonstrations} demonstrations, the limit is ${limits.demonstrations}.`);
  for (const [where, value] of proseFields) {
    const textValue = String(value || "");
    if (/```/.test(textValue)) errors.push(`${where} contains a code block. Code belongs in excerpts.`);
    if (/^\s*#{1,6}\s/m.test(textValue)) errors.push(`${where} contains a heading.`);
    if (/^\s*Source:/m.test(textValue)) errors.push(`${where} contains a "Source:" line. The page adds sources itself.`);
  }

  const questions = list(nb.unresolved);
  if (questions.length > limits.unresolved) errors.push(`There are ${questions.length} open questions, the limit is ${limits.unresolved}.`);
  for (const [i, question] of questions.entries()) {
    over(`Open question ${i + 1}`, question, limits.questionWords);
    for (const other of questions.slice(0, i)) if (similar(question, other)) errors.push(`Open question ${i + 1} repeats an earlier one: "${question}".`);
  }

  // Every number in the prose should be in a file the page cites.
  const cited = new Set(excerpts.map(item => item.file));
  for (const item of list(nb.evidence)) { const file = await sourcePath(root, item); if (file) cited.add(file); }
  const pool = [];
  for (const file of cited) pool.push(...fileNumbers(await fs.promises.readFile(path.join(root, file), "utf8")));
  const unbacked = new Set();
  for (const [, value] of proseFields) for (const claim of claimedNumbers(value)) if (!backed(claim, pool)) unbacked.add(claim);
  if (unbacked.size) warnings.push(`These numbers are not in any cited file: ${[...unbacked].join(", ")}. Add the file they come from to evidence, correct them, or say how they were derived.`);
  return {errors, warnings};
}

// The page, laid out by code from the checked fields. Excerpts that still break a rule are repaired here:
// dropped when their file is missing or their lines were already shown, cut when too long.
async function renderGuide(root, nb, limits) {
  const repairs = [];
  const lines = ["<!-- REGAIN_AGENT_V2 -->", `# ${oneLine(nb.title)}`, "", prose(nb.verdict), ""];
  const terms = list(nb.terms).filter(term => String(term.term || "").trim());
  if (terms.length) lines.push("Words used here:", "", ...terms.map(term => `- ${oneLine(term.term)}: ${oneLine(term.meaning)}`), "");
  const shown = [];
  let demonstrations = 0;
  for (const section of list(nb.sections)) {
    lines.push(`## ${oneLine(section.heading)}`, "", prose(section.takeaway), "", prose(section.body), "");
    for (const excerpt of list(section.excerpts).slice(0, limits.excerptsPerSection)) {
      const file = await sourcePath(root, excerpt.path);
      if (!file) { repairs.push(`Dropped an excerpt of missing file ${excerpt.path}.`); continue; }
      const count = (await fs.promises.readFile(path.join(root, file), "utf8")).split(/\r?\n/).length;
      let lo = Number(excerpt.startLine), hi = Math.min(Number(excerpt.endLine), count);
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1 || hi < lo) { repairs.push(`Dropped an excerpt of ${file} with lines ${excerpt.startLine}-${excerpt.endLine}.`); continue; }
      if (shown.some(other => other.file === file && lo <= other.hi && hi >= other.lo)) { repairs.push(`Dropped a repeated excerpt of ${file} lines ${lo}-${hi}.`); continue; }
      const end = Math.min(hi, lo + limits.excerptLines - 1);
      const cut = end < hi ? ` Showing lines ${lo}-${end} of ${lo}-${hi}. Open the file for the rest.` : "";
      if (cut) repairs.push(`Cut ${file} lines ${lo}-${hi} to ${lo}-${end}.`);
      shown.push({file, lo, hi: end});
      lines.push(`### ${oneLine(excerpt.heading)}`, "", oneLine(excerpt.notice) + cut, "", `Source: [${file} lines ${lo}-${end}](../${file})`, "", "```file " + `${file} ${lo}-${end}`, "```", "");
    }
    for (const item of list(section.demonstrations)) {
      const code = String(item.code || "").replace(/\r\n/g, "\n").trim();
      if (!code || code.length > 8000 || code.includes("```") || demonstrations >= limits.demonstrations) continue;
      demonstrations++;
      lines.push(`### Try it: ${oneLine(item.title)}`, "", oneLine(item.explanation), "",
        `\`\`\`${item.language === "shell" ? "shell" : "python"}`, code, "```", "", `Expected observation: ${oneLine(item.observation)}`, "");
    }
  }
  const questions = list(nb.unresolved).map(oneLine).filter(Boolean).slice(0, limits.unresolved);
  if (questions.length) lines.push("## Open questions", "", ...questions.map(item => `- ${item}`), "");
  return {page: lines.join("\n"), repairs};
}

// The lines that matter most, kept as hash-bound reviews for the line colours.
async function saveDecisions(root, decisions, limit) {
  const reviewsPath = path.join(root, ".regain", "importance-reviews.json");
  let reviews = [];
  try { reviews = JSON.parse(await fs.promises.readFile(reviewsPath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!Array.isArray(reviews)) throw new Error("Existing importance-reviews.json is not an array");
  let added = 0;
  for (const decision of list(decisions).slice(0, limit)) {
    const file = await sourcePath(root, decision.path);
    if (!file || !["critical", "important", "supporting"].includes(decision.importance)) continue;
    const source = (await fs.promises.readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");
    const sourceLines = source.split("\n");
    const line = Number(decision.line), match = String(decision.match || "").trim(), why = oneLine(decision.why);
    if (!Number.isInteger(line) || line < 1 || line > sourceLines.length || !match || !why || !sourceLines[line - 1].includes(match)) continue;
    const sha256 = crypto.createHash("sha256").update(source).digest("hex");
    if (reviews.some(item => item.file === file && item.line === line && item.sha256 === sha256)) continue;
    reviews.push({file, sha256, match, line, importance: decision.importance, why});
    added++;
  }
  if (added) {
    await fs.promises.mkdir(path.dirname(reviewsPath), {recursive: true});
    await fs.promises.writeFile(reviewsPath, JSON.stringify(reviews, null, 2) + "\n", "utf8");
  }
  return added;
}

// The page goes to capability-<id>.regain.md, and next to it a record of how it was made:
// the draft, the review's scores and fixes, the checks before and after, and any repairs.
async function saveGuide(root, capability, notebook, record, limits) {
  const regain = path.join(root, ".regain");
  await fs.promises.mkdir(regain, {recursive: true});
  let base = `capability-${capability.id}`;
  try {
    const previous = await fs.promises.readFile(path.join(regain, `${base}.regain.md`), "utf8");
    if (!/REGAIN_AGENT_V\d/.test(previous)) base = `${base}-${Date.now()}`;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const notebookPath = path.join(regain, `${base}.regain.md`);
  const {page, repairs} = await renderGuide(root, notebook, limits);
  await fs.promises.writeFile(notebookPath, page, "utf8");
  const reviewed = await saveDecisions(root, notebook.decisions, limits.decisions);
  const recordPath = path.join(regain, `${base}.guide.json`);
  await fs.promises.writeFile(recordPath, JSON.stringify({at: new Date().toISOString(), subject: capability.name, ...record, repairs, notebook}, null, 2) + "\n", "utf8");
  return {notebookPath, recordPath, sections: list(notebook.sections).length, reviewedLines: reviewed, repairs};
}

const cancelled = error => /cancelled/i.test(error?.message || "");

// Write, check, review, check, fix if needed, save. call(kind, request, title) runs one agent call.
async function writeGuide(root, map, capability, {call, learner, context}) {
  const limits = notebookLimits(await projectBudget(root));
  const draft = await call("detail", await detailPrompt(root, map, capability, learner, context), `Writing the guide for ${capability.name}`);
  if (!draft || !list(draft.sections).length) throw new Error("Agent returned no sections");
  const draftCheck = await checkNotebook(root, draft, limits);
  let notebook = draft, check = draftCheck, review = null;
  const problems = [];
  try {
    const raw = await call("review", await reviewPrompt(root, map, capability, draft, draftCheck), `Reviewing the guide for ${capability.name}`);
    review = {scores: list(raw?.scores), problems: list(raw?.problems)};
    if (raw?.notebook && list(raw.notebook.sections).length) {
      const reviewedCheck = await checkNotebook(root, raw.notebook, limits);
      // The review's version wins unless it broke more hard rules than the draft.
      if (reviewedCheck.errors.length <= check.errors.length) { notebook = raw.notebook; check = reviewedCheck; }
      else problems.push(`The review's version broke ${reviewedCheck.errors.length} hard rules against the draft's ${check.errors.length}, so the draft was kept.`);
    }
  } catch (error) {
    if (cancelled(error)) throw error;
    problems.push(`The review stopped: ${error.message}`);
  }
  if (check.errors.length) {
    try {
      const fixed = await call("fix", await fixPrompt(root, notebook, check), `Fixing the guide for ${capability.name}`);
      const fixedCheck = fixed && list(fixed.sections).length ? await checkNotebook(root, fixed, limits) : null;
      if (fixedCheck && fixedCheck.errors.length < check.errors.length) { notebook = fixed; check = fixedCheck; }
    } catch (error) {
      if (cancelled(error)) throw error;
      problems.push(`The fix stopped: ${error.message}`);
    }
  }
  const saved = await saveGuide(root, capability, notebook, {draft, checks: {draft: draftCheck, final: check}, review, problems}, limits);
  return {...saved, remaining: check.errors, problems};
}

module.exports = {checkNotebook, renderGuide, saveGuide, writeGuide, claimedNumbers, backed};
