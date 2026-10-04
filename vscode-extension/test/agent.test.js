// Budgets, live progress, prompt scope and notebook limits.
const Module = require("module");
const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path");

const fake = {workspace: {getConfiguration: () => ({get: (key, fallback) => fallback})}, extensions: {getExtension: () => null}};
const load = Module._load;
Module._load = (req, ...rest) => req === "vscode" ? fake : load(req, ...rest);
const {budgetFor, measureProject, budgetText} = require("../budget");
const {describeClaudeEvent, describeCodexEvent, startProgress} = require("../progress");
const {mapPrompt, notesPrompt, branchPrompt, detailPrompt, reviewPrompt, fixPrompt, chatPrompt, mapSchema, branchSchema, notebookSchema} = require("../agent-runner");
const {normalizeMap, tidy} = require("../semantic-map");
const {checkNotebook, renderGuide, writeGuide, claimedNumbers, backed} = require("../guide");
const {notebookLimits} = require("../budget");
const {checkSvg, makeVisual} = require("../visual");
const {visualPrompt} = require("../agent-runner");
const {applyOps} = require("../map-ops");
const {buildIndex} = require("../project-index");
const {readAllFiles, makeBatches, notebookText, notesText} = require("../file-notes");
const {estimates} = require("../page-state");
const {sendMessage, decideSuggestion} = require("../overview-chat");
const {loadConversation, loadLearner, updateProgress} = require("../conversation");

(async () => {
  // size picks the tier; the hard step cap sits well above what the prompt asks for
  assert.strictEqual(budgetFor({files: 90, lines: 10000}).label, "small");
  assert.strictEqual(budgetFor({files: 400, lines: 40000}).label, "medium");
  const large = budgetFor({files: 3000, lines: 300000});
  assert.strictEqual(large.label, "large");
  assert.ok(large.maxTurns.detail > large.steps.detail);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "regain-agent-"));
  for (const dir of ["src", "archive", "node_modules/x", ".regain", "docs"]) fs.mkdirSync(path.join(root, dir), {recursive: true});
  fs.writeFileSync(path.join(root, "src/a.py"), "x = 1\ny = 2\n");
  fs.writeFileSync(path.join(root, "src/long.py"), Array.from({length: 300}, (_, i) => `v${i} = ${i}`).join("\n") + "\n");
  fs.writeFileSync(path.join(root, "archive/old.py"), "z = 3\n");
  fs.writeFileSync(path.join(root, "node_modules/x/dep.js"), "skip\n");
  fs.writeFileSync(path.join(root, "docs/note.md"), "# Note\nresult 0.70\n");
  const size = await measureProject(root);
  assert.deepStrictEqual([size.files, size.historyFiles], [2, 1], "archive counted apart, dependencies skipped, docs not code");
  assert.ok(budgetText(budgetFor(size), "map").includes("archive-style folders"));

  // progress lines from both providers
  assert.deepStrictEqual(describeClaudeEvent({type: "assistant", message: {content: [
    {type: "text", text: "Reading the loop."},
    {type: "tool_use", name: "Read", input: {file_path: path.join(root, "src/a.py")}},
    {type: "tool_use", name: "Grep", input: {pattern: "train"}},
    {type: "tool_use", name: "StructuredOutput", input: {}}]}}, root),
  ["Reading the loop.", "Reading src/a.py", 'Searching for "train"', "Writing the result"]);
  assert.deepStrictEqual(describeClaudeEvent({type: "system", subtype: "init"}, root), []);
  assert.deepStrictEqual(describeClaudeEvent({type: "assistant", message: {content: [{type: "thinking", thinking: "Check the loop first."}]}}, root), ["Thinking: Check the loop first."]);
  assert.deepStrictEqual(describeCodexEvent({type: "item.started", item: {type: "command_execution", command: "bash -lc 'rg -n train src'"}}), ["Running: rg -n train src"]);
  assert.deepStrictEqual(describeCodexEvent({type: "item.completed", item: {type: "agent_message", text: "{\"children\":[]}"}}), [], "final JSON is not a step");

  const logged = [], reported = [];
  let now = 0;
  const tracker = startProgress("Test", message => reported.push(message), {log: {appendLine: line => logged.push(line)}, now: () => now, show: false});
  now = 65000;
  tracker.step("Reading src/a.py");
  assert.strictEqual(reported.at(-1), "Reading src/a.py · 1 step · 1:05");
  assert.ok(logged.includes("[1:05] Reading src/a.py"));
  now = 75000;
  tracker.note("still here");
  tracker.step("Reading src/b.py");
  now = 90000;
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.ok(reported.at(-1).startsWith("Thinking… (last: Reading src/b.py)"), "a quiet agent shows it is still thinking");
  assert.strictEqual(tracker.finish("Done"), 90000);

  // subjects carry a kind in both schemas and in the saved map
  for (const schema of [mapSchema, branchSchema]) {
    const item = (schema.properties.capabilities || schema.properties.children).items;
    assert.ok(item.required.includes("kind"));
  }
  const map = await normalizeMap(root, {projectName: "p", summary: "Asks whether X beats Y.", uncertainties: [], capabilities: [
    {id: "status", name: "Question and status", purpose: "Where it stands.", kind: "status", runtimeStatus: "research",
      sources: [{path: "docs/note.md", reason: "verdict"}], flow: [{id: "s", label: "Step", description: "d", sources: ["docs/note.md"]}], related: []},
    {id: "core", name: "Core", purpose: "Does the work.", kind: "nonsense", runtimeStatus: "runtime",
      sources: [{path: "src/a.py", reason: "entry"}], flow: [{id: "c", label: "Run", description: "d", sources: ["src/a.py"]}], related: []}]});
  assert.deepStrictEqual(map.capabilities.map(item => item.kind), ["status", "code"], "unknown kinds fall back to code");
  map.capabilities[1].children = [{id: "core--part", name: "Part", purpose: "p", kind: "code", sources: [{path: "src/long.py", reason: "r"}], flow: [], children: []}];

  // prompts: budget, place in the map, and a page shaped by its kind
  const mapRequest = await mapPrompt(root);
  assert.ok(mapRequest.text.includes("4-6 top-level subjects") && !/as long as needed/.test(mapRequest.text));
  assert.ok(mapRequest.text.includes("simple, intuitive everyday words") && mapRequest.text.includes("informative and accurate"));
  assert.strictEqual(mapRequest.maxTurns, budgetFor(size).maxTurns.map);
  const learner = {knows: ["the research question"], cares: ["step 3"], open: []};
  const status = (await detailPrompt(root, map, map.capabilities[0], learner)).text;
  assert.ok(status.includes("one per milestone") && status.includes("It is the whole page"), "the notebook is written whole, shaped by its kind");
  assert.ok(status.includes("Verdict first") && status.includes("Does blending clips help?"), "the rubric and the example are in the prompt");
  assert.ok(status.includes("the research question") && status.includes("step 3"), "the user's record steers the page");
  assert.ok(status.includes("siblings") && status.includes("Core"), "siblings are named so the page skips them");
  const core = (await detailPrompt(root, map, map.capabilities[1])).text;
  assert.ok(core.includes("parts with their own pages: Part"));
  assert.ok(!core.includes("src/long.py"), "a part's sources stay out of the parent's page");
  const branch = (await branchPrompt(root, map, map.capabilities[1])).text;
  assert.ok(branch.includes("2-5 children") && branch.includes("simple, intuitive everyday words"));
  assert.ok(core.includes("informative and accurate"));
  const index = await buildIndex(root);
  assert.ok((await mapPrompt(root, index)).text.includes("src/long.py (301 lines"), "the map prompt sees every file through the index");

  // the notebook's hard rules: what the radSeq page got wrong is caught before it is saved
  fs.mkdirSync(path.join(root, "results"));
  fs.writeFileSync(path.join(root, "results/score.json"), '{"base": 0.6651, "with_generated": 0.7050, "gain": 0.0400018625}\n');
  const limits = notebookLimits(budgetFor(size));
  const verdict = "Generated data helps on the simulator. The score rose from 0.665 to 0.705 across three seeds, but a copying check says the generator memorizes its training scenes, so the gain may come from near copies.";
  const good = {title: "Does generated data help?", verdict, terms: [{term: "AP", meaning: "a score combining correct detections with found targets"}],
    sections: [
      {heading: "Load the values", takeaway: "The script reads 300 values from one file.", body: "Each value is a plain number. Nothing is filtered.", demonstrations: [],
        excerpts: [{path: "src/long.py", startLine: 1, endLine: 20, heading: "Read every value", notice: "Line 3 shows the pattern every line follows."}]},
      {heading: "Compare the two pools", takeaway: "Two pools differ only in the generated additions.", body: "Same seeds, same updates.", demonstrations: [], excerpts: []},
      {heading: "Read the verdict", takeaway: "The gain is 0.0400 against the base of 0.665.", body: "The rule passes.", demonstrations: [],
        excerpts: [{path: "results/score.json", startLine: 1, endLine: 1, heading: "Scores and gain", notice: "The gain field is computed by the script."}]}],
    unresolved: ["Does the gain survive when the copying check passes?"], evidence: [], decisions: []};
  assert.deepStrictEqual(await checkNotebook(root, good, limits), {errors: [], warnings: []}, "a clean notebook passes");
  const bad = JSON.parse(JSON.stringify(good));
  bad.sections[0].heading = "long.py";
  bad.sections[1].heading = "Read the verdict";
  bad.sections[1].excerpts = [{path: "src/long.py", startLine: 10, endLine: 400, heading: "Again", notice: "See it."}];
  bad.sections[2].body = "Read this:\n```python\nx = 1\n```\n" + "word ".repeat(220);
  bad.unresolved.push("Does the gain survive when the copying check passes, really?");
  bad.verdict = "Too short.";
  bad.sections[2].takeaway = "The gain is 0.0500 against the base.";
  const found = await checkNotebook(root, bad, limits);
  for (const pattern of [/file name/, /used twice/, /overlap/, /ends at line 400/, /code block/, /body has \d+ words/, /repeats an earlier one/, /verdict has 2 words/])
    assert.ok(found.errors.some(item => pattern.test(item)), `catches ${pattern}`);
  assert.ok(found.warnings.some(item => item.includes("0.0500")), "a number in no cited file is flagged");
  assert.deepStrictEqual(claimedNumbers("lines 116-155 hold 8,000 items, 0.705 and 3 seeds"), ["8,000", "0.705"]);
  assert.ok(backed("0.0400", [0.0400018625]) && backed("74.0", [0.74]) && !backed("0.05", [0.04]));

  // the page is laid out by code: idea headings, no cut prose, repeats dropped, long excerpts cut
  const long = JSON.parse(JSON.stringify(good));
  long.sections[1].body = "A long but complete paragraph. ".repeat(60) + "The last words survive.";
  long.sections[1].excerpts = [{path: "src/long.py", startLine: 5, endLine: 9, heading: "Same lines again", notice: "Repeat."},
    {path: "src/long.py", startLine: 100, endLine: 290, heading: "Many lines", notice: "Long."}];
  const rendered = await renderGuide(root, long, limits);
  assert.ok(rendered.page.startsWith("<!-- REGAIN_AGENT_V2 -->\n# Does generated data help?\n\n" + verdict), "the verdict opens the page");
  assert.ok(rendered.page.includes("The last words survive."), "prose is never cut");
  assert.ok(rendered.page.includes("### Read every value") && !rendered.page.includes("### long.py"), "excerpts are headed by their idea");
  assert.ok(!rendered.page.includes("Same lines again"), "lines already shown are dropped");
  assert.ok(rendered.page.includes(`\`\`\`file src/long.py 100-${99 + limits.excerptLines}`) && rendered.page.includes("Open the file for the rest"));
  assert.ok(rendered.page.includes("## Open questions\n\n- Does the gain survive"), "open questions appear once, at the end");
  assert.strictEqual(rendered.repairs.length, 2);

  // write, review, fix: the review's version wins, the fix runs only while hard errors remain
  const calls = [];
  const fakeCall = answers => async (kind, request) => { calls.push(kind); assert.ok(request.text.length > 100); const answer = answers[kind]; if (answer instanceof Error) throw answer; return answer; };
  const reviewed = await writeGuide(root, map, map.capabilities[1], {call: fakeCall({detail: bad, review: {scores: [{criterion: "Verdict first", score: 4, note: "n"}], problems: [{where: "verdict", problem: "short", fix: "rewrote"}], notebook: good}})});
  assert.deepStrictEqual(calls, ["detail", "review"], "no fix call when the review's version passes");
  assert.deepStrictEqual(reviewed.remaining, []);
  const saved = JSON.parse(fs.readFileSync(reviewed.recordPath, "utf8"));
  assert.ok(saved.checks.draft.errors.length > 5 && saved.checks.final.errors.length === 0 && saved.review.problems.length === 1 && saved.draft.verdict === "Too short.");
  assert.ok(fs.readFileSync(reviewed.notebookPath, "utf8").includes("## Compare the two pools"));
  calls.length = 0;
  const rescued = await writeGuide(root, map, map.capabilities[1], {call: fakeCall({detail: bad, review: new Error("timeout"), fix: good})});
  assert.deepStrictEqual(calls, ["detail", "review", "fix"], "a failed review still gets a fix call");
  assert.ok(rescued.problems[0].includes("timeout") && !rescued.remaining.length);
  calls.length = 0;
  await assert.rejects(writeGuide(root, map, map.capabilities[1], {call: fakeCall({detail: good, review: new Error("Analysis cancelled")})}), /cancelled/);
  await assert.rejects(writeGuide(root, map, map.capabilities[1], {call: fakeCall({detail: {sections: []}})}), /no sections/);
  assert.ok(notebookSchema.required.includes("verdict") && !JSON.stringify(notebookSchema).includes("depth"));
  for (const request of [await reviewPrompt(root, map, map.capabilities[1], good, {errors: [], warnings: []}), await fixPrompt(root, good, {errors: ["The title is empty."], warnings: []})])
    assert.ok(!/[;—–]/.test(request.text) && request.maxTurns > 0, "review and fix prompts carry no semicolons or long dashes");

  // "Draw a visual": the agent's SVG is checked before it is saved
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 300"><title>Maps flow in</title><rect width="600" height="300" fill="#f8fafb"/></svg>';
  assert.strictEqual(checkSvg('<?xml version="1.0"?>\n' + svg), svg);
  assert.ok(checkSvg('<svg viewBox="0 0 10 10"></svg>').includes('xmlns="http://www.w3.org/2000/svg"'), "a missing namespace is added");
  for (const [unsafe, why] of [['<svg viewBox="0 0 1 1"><script>x()</script></svg>', /scripts/], ['<svg viewBox="0 0 1 1"><rect onclick="x()"/></svg>', /scripts/],
    ['<svg viewBox="0 0 1 1"><a href="https://x.org">x</a></svg>', /outside/], ['<svg width="10"></svg>', /viewBox/], ["A picture of maps", /complete SVG/]])
    assert.throws(() => checkSvg(unsafe), why);
  const visualFile = path.join(root, ".regain/visuals/long-1-20.svg");
  const drawn = await makeVisual(root, {pageTitle: "Guide", pageText: "## Load the values\n\nReads 300 values.", target: "the file src/long.py (lines 1-20)", code: "", label: "long.py", file: visualFile},
    async (kind, request) => { assert.strictEqual(kind, "visual"); assert.ok(request.text.includes("src/long.py (lines 1-20)") && request.text.includes("Reads 300 values.")); return {title: "Maps flow in", svg}; });
  assert.strictEqual(drawn.title, "Maps flow in");
  assert.strictEqual(fs.readFileSync(visualFile, "utf8"), svg + "\n");
  await assert.rejects(makeVisual(root, {file: path.join(root, ".regain/visuals/bad.svg"), target: "x"}, async () => ({title: "t", svg: "<svg><script/></svg>"})), /complete SVG|viewBox|scripts/);
  assert.ok(!fs.existsSync(path.join(root, ".regain/visuals/bad.svg")), "a rejected picture is not saved");
  const visualText = (await visualPrompt(root, {pageTitle: "Guide", pageText: "", target: "the file src/a.py", code: ""})).text;
  assert.ok(!/[;—–]/.test(visualText) && visualText.includes("Never invent values"), "the visual prompt is plain and asks for real values");

  // map changes from the conversation: checked, then applied
  const live = JSON.parse(JSON.stringify(map));
  delete live.capabilities[1].children;
  const ops = applyOps(live, [
    {op: "rename", id: "core", name: "Run the core"},
    {op: "add", name: "Check results", purpose: "p", kind: "experiment", sources: ["docs/note.md"], after: "status"},
    {op: "add", name: "Ghost", purpose: "p", kind: "code", sources: ["nope.py"], after: ""},
    {op: "rename", id: "status", name: "a name that is far too long to be a subject"},
    {op: "merge", ids: ["status", "check-results"], name: "Question and results", purpose: "Both."},
    {op: "move", id: "core", after: ""},
  ], root);
  assert.deepStrictEqual(live.capabilities.map(item => item.name), ["Run the core", "Question and results"]);
  assert.deepStrictEqual(ops.rejected.map(item => item.op), ["add", "rename"], "a missing file and a long name are refused");
  assert.ok(ops.applied.find(item => item.op === "merge").ids.length === 1);
  const split = applyOps(live, [{op: "split", id: "core", into: [{name: "Read", purpose: "r", kind: "code", sources: ["src/a.py"]}, {name: "Write", purpose: "w", kind: "code", sources: ["src/long.py"]}]}], root);
  assert.deepStrictEqual(live.capabilities.map(item => item.name), ["Read", "Write", "Question and results"]);
  assert.strictEqual(split.applied[0].ids.length, 2);

  // reading every file: batches, notebooks without outputs, a cache that rereads only changed files
  fs.writeFileSync(path.join(root, "docs/notebook.ipynb"), JSON.stringify({cells: [{cell_type: "markdown", source: ["# Steps"]}, {cell_type: "code", source: ["x = 1"], outputs: [{data: {"image/png": "A".repeat(50000)}}]}]}));
  assert.ok(!notebookText(fs.readFileSync(path.join(root, "docs/notebook.ipynb"), "utf8")).includes("AAAA"), "notebook outputs are dropped");
  assert.strictEqual(makeBatches(Array.from({length: 30}, (_, i) => ({path: `f${String(i).padStart(2, "0")}.py`, text: "x".repeat(4000)}))).length, 2, "batches stay under the size and file limits");
  const fullIndex = await buildIndex(root);
  const readerCalls = [];
  const fakeReader = async (_, kind, request) => {
    readerCalls.push(request);
    const paths = [...request.text.matchAll(/=== FILE: (\S+)/g)].map(m => m[1]);
    return {notes: paths.map(file => ({path: file, role: "Role of " + file, details: "", decides: ""}))};
  };
  const first = await readAllFiles(root, fullIndex, {run: fakeReader, prompt: batch => notesPrompt(batch, "demo")});
  const wanted = fullIndex.filter(item => ["code", "config", "result", "doc"].includes(item.kind)).length;
  assert.strictEqual(first.read, wanted, "every text file is read, archive and docs included");
  assert.ok(first.notes["archive/old.py"] && first.notes["docs/note.md"]);
  assert.ok(readerCalls[0].noTools && readerCalls[0].text.includes("=== FILE: "), "file text goes in the prompt, with no tools");
  const before = readerCalls.length;
  fs.writeFileSync(path.join(root, "src/a.py"), "x = 1\ny = 3\n");
  const second = await readAllFiles(root, fullIndex, {run: fakeReader, prompt: batch => notesPrompt(batch, "demo")});
  assert.strictEqual(readerCalls.length - before, 1, "only the changed file is read again");
  assert.strictEqual(second.reread, 1);
  const failing = await readAllFiles(root, fullIndex, {run: async () => ({notes: []}), prompt: batch => notesPrompt(batch, "demo")});
  assert.strictEqual(failing.failed.length, 0, "cached notes survive a failing reader");
  assert.ok(notesText(second.notes, fullIndex).includes("docs/note.md (document: a claim, check it against the code)"));
  const notesMap = await mapPrompt(root, fullIndex, second.notes);
  assert.ok(notesMap.text.includes("Every file in the project has already been read") && notesMap.text.includes("Role of src/long.py"));
  assert.ok(notesMap.text.includes("treat them as claims") && notesMap.text.includes("state:") && notesMap.text.includes("openQuestions"));

  // the new map fields survive normalizing
  const rich = await normalizeMap(root, {projectName: "p", summary: "S.", story: {asks: "A; b", done: "D", next: "N"}, terms: [{term: "DiT", meaning: "The generator."}, {term: "dit", meaning: "dup"}],
    openQuestions: ["Did it finish?"], uncertainties: [], capabilities: [{id: "x", name: "X", purpose: "p", kind: "code", role: "side", state: "in_progress", runtimeStatus: "runtime",
      sources: [{path: "src/a.py", reason: "r"}], flow: [{id: "f", label: "L", description: "d", state: "done", sources: ["src/a.py"]}], related: []}]});
  assert.deepStrictEqual(rich.story, {asks: "A. B", done: "D", next: "N"});
  assert.deepStrictEqual([rich.capabilities[0].role, rich.capabilities[0].state, rich.capabilities[0].flow[0].state], ["side", "in_progress", "done"]);
  assert.strictEqual(rich.terms.length, 1, "duplicate terms are dropped");
  assert.deepStrictEqual(rich.openQuestions, ["Did it finish?"]);

  // the conversation, end to end with a stand-in agent
  fs.writeFileSync(path.join(root, ".regain/semantic-map.json"), JSON.stringify({...map, openQuestions: ["Did training finish?"], capabilities: map.capabilities.map(c => ({...c, children: []}))}));
  const posted = [], prompts = [];
  let reply = {reply: "radSeq asks one question — here are the subjects.", apply: [{op: "rename", id: "core", name: "Do the work", ids: [], purpose: "", kind: "code", state: "unknown", sources: [], after: "", into: [], reason: "plainer"}],
    suggest: [{op: "remove", id: "status", name: "", ids: [], purpose: "", kind: "code", state: "unknown", sources: [], after: "", into: [], reason: "too thin"}],
    record: {knows: ["the goal"], cares: [], open: []}, openQuestions: [], facts: ["made up"]};
  const fakeRun = async (_, kind, request) => {
    prompts.push(request.text);
    request.onStep?.("Reading src/a.py", "0:01");
    return reply;
  };
  await sendMessage(root, {}, {run: fakeRun, post: m => posted.push(m), report: () => {}});
  assert.ok(prompts[0].includes("Open the conversation") && prompts[0].includes("do not repeat the summary or list the subjects"));
  assert.ok(prompts[0].includes("Role of src/long.py"), "the guide works from the notes");
  assert.ok(posted.some(m => m.type === "chatProgress" && m.text === "Reading src/a.py"), "live steps reach the page");
  let convo = await loadConversation(root);
  assert.strictEqual(convo[0].text, "radSeq asks one question, here are the subjects.", "replies are tidied");
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, ".regain/semantic-map.json"), "utf8")).capabilities[1].name, "Do the work");
  let record = await loadLearner(root);
  assert.deepStrictEqual([record.knows, record.told], [[], []], "the opening message does not fill in the record");
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, ".regain/semantic-map.json"), "utf8")).openQuestions, ["Did training finish?"], "nor clear the open questions");
  const last = posted.at(-1);
  assert.ok(last.type === "state" && last.glow.includes("core") && !last.pending && last.progress && last.estimates);

  // the user answers an open question: the fact is kept, the question goes, the subject is marked
  reply = {reply: "Thanks.", apply: [{op: "mark", id: "core", name: "", ids: [], purpose: "", kind: "code", state: "done", sources: [], after: "", into: [], reason: "training finished"}], suggest: [],
    record: {knows: ["the goal"], cares: ["training"], open: []}, openQuestions: [], facts: ["Training finished on 28 September."]};
  await sendMessage(root, {text: "Training finished on the 28th.", selectedId: "core"}, {run: fakeRun, post: m => posted.push(m), report: () => {}});
  assert.ok(prompts[1].includes("User: Training finished on the 28th.") && prompts[1].includes("selected on the map: Do the work") && prompts[1].includes("Did training finish?"));
  const after = JSON.parse(fs.readFileSync(path.join(root, ".regain/semantic-map.json"), "utf8"));
  assert.deepStrictEqual(after.openQuestions, []);
  assert.strictEqual(after.capabilities[1].state, "done");
  record = await loadLearner(root);
  assert.deepStrictEqual([record.knows, record.told], [["the goal"], ["Training finished on 28 September."]]);
  assert.ok((await chatPrompt(root, after, {messages: [], learner: record})).text.includes("Facts the user told ReGain"), "every prompt hears what the user told ReGain");

  await decideSuggestion(root, {message: 0, index: 0, apply: true}, {post: m => posted.push(m)});
  convo = await loadConversation(root);
  assert.strictEqual(convo[0].suggested[0].status, "applied");
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, ".regain/semantic-map.json"), "utf8")).capabilities.length, 1, "a removed subject does not come back on save");
  await sendMessage(root, {text: "x"}, {run: async () => { throw new Error("agent down"); }, post: m => posted.push(m), report: () => {}});
  assert.strictEqual((await loadConversation(root)).at(-1).status, "error");

  // the user's path, and the usual time of each kind of call
  await updateProgress(root, {started: "core"});
  const marked = await updateProgress(root, {id: "core", covered: true});
  assert.deepStrictEqual([marked.started, marked.covered], [["core"], ["core"]]);
  assert.deepStrictEqual((await updateProgress(root, {id: "core", covered: false})).covered, []);
  fs.writeFileSync(path.join(root, ".regain/agent-runs.jsonl"), [
    {kind: "detail", ok: true, ms: 200000}, {kind: "detail", ok: true, ms: 260000}, {kind: "detail", ok: false, ms: 5000}, {kind: "detail", ok: true, ms: 240000},
    {kind: "chat", title: "Opening the conversation", ok: true, ms: 90000}, {kind: "chat", title: "Answering", ok: true, ms: 20000}].map(x => JSON.stringify(x)).join("\n"));
  assert.deepStrictEqual(await estimates(root), {detail: 240000, opening: 90000, chat: 20000});

  // no semicolons or long dashes in text the user reads, or in the prompts' own wording
  assert.strictEqual(tidy("Renders frames — then labels; done."), "Renders frames, then labels. Done.");
  assert.strictEqual(tidy("lines 10–20 and `a; b`"), "lines 10-20 and `a; b`");
  const plainMap = {...map, summary: "Plain.", capabilities: map.capabilities.map(c => ({...c, purpose: "Plain."}))};
  for (const request of [mapRequest, await branchPrompt(root, plainMap, plainMap.capabilities[1]), await detailPrompt(root, plainMap, plainMap.capabilities[0]), await chatPrompt(root, plainMap, {messages: []})])
    assert.ok(!/[;—–]/.test(request.text), "prompt wording carries no semicolons or long dashes");
  const tidied = await normalizeMap(root, {projectName: "p", summary: "One; two — three.", uncertainties: [], capabilities: [{id: "x", name: "Name — long", purpose: "A; b.", kind: "code", runtimeStatus: "runtime",
    sources: [{path: "src/a.py", reason: "r"}], flow: [{id: "f", label: "L", description: "d; e", sources: ["src/a.py"]}], related: []}]});
  assert.ok(!/[;—]/.test(JSON.stringify([tidied.summary, tidied.capabilities[0].name, tidied.capabilities[0].purpose, tidied.capabilities[0].flow[0].description])));

  console.log("agent: all passed");
})().catch(error => { console.error(error); process.exit(1); });
