// The overview conversation on the page, and "Go deeper" in the notebook view.
const assert = require("assert");
const fs = require("fs");
const {JSDOM} = require("jsdom");
const {semanticDiagram} = require("../semantic-tree-diagram");

const node = (id, name) => ({id, name, kind: "code", purpose: "Purpose " + id, flow: [], sources: [{path: "src/a.py", reason: "r"}], related: [], children: [], refined: false});
const map = {projectName: "Demo", summary: "Demo.", capabilities: [node("a", "First"), node("b", "Second")], reading: {read: 1, total: 3, unread: ["src/b.py", "src/c.py"]}};
const conversation = [
  {role: "agent", text: "Two subjects:\n\n- First\n- Second", suggested: [{op: "merge", ids: ["a", "b"], name: "Both", reason: "they overlap", status: "pending"}]},
];
const sent = [];
const dom = new JSDOM(semanticDiagram(map, {conversation, learner: {knows: ["the goal"], cares: [], open: []}}), {runScripts: "dangerously",
  beforeParse(w) { w.regainApi = {getState: () => ({}), setState: () => {}, postMessage: m => sent.push(JSON.parse(JSON.stringify(m)))}; w.HTMLElement.prototype.scrollIntoView = () => {}; }});
const w = dom.window, d = w.document;
w.HTMLFormElement.prototype.requestSubmit = function () { this.dispatchEvent(new w.Event("submit", {cancelable: true})); };
w.dispatchEvent(new w.Event("DOMContentLoaded"));

assert.ok(d.querySelector(".reading summary").textContent.includes("read 1 of 3 code files"), "what the agent read is shown");
assert.strictEqual(d.querySelectorAll(".msg.agent li").length, 2, "agent lists render as lists");
assert.ok(d.querySelector(".record").textContent.includes("the goal"));
assert.strictEqual(sent.length, 0, "opening the page starts no agent");

// Apply on a suggestion
[...d.querySelectorAll(".suggest button")].find(b => b.textContent === "Apply").click();
assert.deepStrictEqual(sent.at(-1), {type: "decideSuggestion", message: 0, index: 0, apply: true});

// sending carries the selected subject and shows a live pending bubble
d.getElementById("askText").value = "What is First?";
d.getElementById("ask").requestSubmit();
assert.deepStrictEqual(sent.at(-1), {type: "chat", text: "What is First?", selectedId: "a"});
assert.ok(d.querySelector(".msg.pending"));
w.dispatchEvent(new w.MessageEvent("message", {data: {type: "chatProgress", text: "Reading src/a.py", time: "0:04"}}));
assert.ok(d.querySelector(".msg.pending").textContent.includes("Reading src/a.py · 0:04"));

// the answer redraws the map and the chat
const changed = {...map, capabilities: [node("both", "Both")]};
w.dispatchEvent(new w.MessageEvent("message", {data: {type: "state", map: changed, conversation: conversation.concat([{role: "user", text: "What is First?"}, {role: "agent", text: "Merged.", applied: [{op: "merge", ids: ["both"], reason: "they overlap"}]}]),
  learner: {knows: ["the goal"], cares: ["merging"], open: []}, glow: ["both"]}}));
assert.ok(!d.querySelector(".msg.pending"));
assert.deepStrictEqual([...d.querySelectorAll(".diagram .box .name")].map(n => n.textContent), ["Both"]);
assert.ok(d.querySelector('.box[data-id="both"]').classList.contains("glow"));
assert.ok(d.querySelector(".msg .changed").textContent.includes("they overlap"));

// the "About" chip can be cleared, so a question is about the whole project
d.querySelector("#about button").click();
d.getElementById("askText").value = "And overall?";
d.getElementById("ask").requestSubmit();
assert.deepStrictEqual(sent.at(-1), {type: "chat", text: "And overall?", selectedId: ""});

// the guide drawer opens and closes from its bar, and the record lists what the user told ReGain
d.getElementById("guideBar").click();
assert.ok(d.getElementById("guide").classList.contains("open"));
w.dispatchEvent(new w.MessageEvent("message", {data: {type: "state", learner: {knows: [], cares: [], open: [], told: ["Training finished."]}}}));
assert.ok(d.getElementById("record").textContent.includes("You told ReGain") && d.getElementById("record").textContent.includes("Training finished."));
dom.window.close();

// an empty conversation offers a Start button
const sent2 = [];
const empty = new JSDOM(semanticDiagram(map, {}), {runScripts: "dangerously", beforeParse(win) { win.regainApi = {getState: () => ({}), setState: () => {}, postMessage: m => sent2.push(JSON.parse(JSON.stringify(m)))}; }});
empty.window.dispatchEvent(new empty.window.Event("DOMContentLoaded"));
[...empty.window.document.querySelectorAll(".start-chat button")][0].click();
assert.deepStrictEqual(sent2.at(-1), {type: "chatStart"});
empty.window.close();

// notebook view: numbered steps, older markers hidden, open questions off the path
const src = fs.readFileSync(__dirname + "/../media/notebook.js", "utf8");
const nb = new JSDOM(`<body class="vscode-dark"><div id="app"></div></body>`, {runScripts: "outside-only", pretendToBeVisual: true});
const nw = nb.window;
nw.acquireVsCodeApi = () => ({postMessage: () => {}, getState: () => ({}), setState: () => {}});
nw.HTMLCanvasElement.prototype.getContext = () => ({set fillStyle(v) {}, get fillStyle() { return "#123456"; }});
nw.CSS = {escape: s => s};
nw.scrollTo = () => {};
nw.eval(src);
const page = "# Guide\n\nWhat goes in.\n\n## Load the data\n<!-- regain:step id=load depth=short sources=src/a.py -->\n\nReads values.\n\n## Save it\n\nWrites values.\n\n## Open questions\n\n- Is it used?";
nw.dispatchEvent(new nw.MessageEvent("message", {data: {type: "render", name: "g.regain.md", blocks: [{kind: "text", src: page, key: 0}], files: {}, outputs: {},
  terms: [{term: "values", meaning: "Numbers the step works on."}]}}));
const doc = nw.document;
assert.ok(!doc.body.textContent.includes("regain:step"), "markers from older guides are hidden");
assert.deepStrictEqual([...doc.querySelectorAll(".step-pill")].map(p => p.textContent), ["Step 1 of 2", "Step 2 of 2"], "open questions are not a step");
assert.strictEqual(doc.querySelectorAll(".deeper").length, 0, "no Go deeper: the guide is written whole");
assert.strictEqual(doc.querySelector(".text .md .term").title, "Numbers the step works on.", "notebooks explain the map's words too");
nb.window.close();
// "Draw a visual" beside a block: the button asks the agent, the panel shows its progress until it is done
const posted = [];
const vw = new JSDOM(`<body class="vscode-dark"><div id="app"></div></body>`, {runScripts: "outside-only", pretendToBeVisual: true}).window;
vw.acquireVsCodeApi = () => ({postMessage: m => posted.push(JSON.parse(JSON.stringify(m))), getState: () => ({}), setState: () => {}});
vw.HTMLCanvasElement.prototype.getContext = () => ({set fillStyle(v) {}, get fillStyle() { return "#123456"; }});
vw.CSS = {escape: s => s};
vw.scrollTo = () => {};
vw.eval(src);
vw.dispatchEvent(new vw.MessageEvent("message", {data: {type: "render", name: "g.regain.md", blocks: [{kind: "text", src: "# Guide", key: 0}, {kind: "code", src: "x = 1", key: 1}],
  files: {}, outputs: {}, visuals: {}, terms: []}}));
const vd = vw.document;
vd.querySelector(".vtab").click();
const drawButton = [...vd.querySelectorAll(".vpanel .tbtn")].find(b => b.textContent === "Draw a visual");
assert.ok(drawButton && vd.querySelector(".vempty").textContent.includes("Draw a visual"));
drawButton.click();
const asked = posted.at(-1);
assert.deepStrictEqual([asked.type, asked.index], ["drawVisual", 1]);
assert.ok([...vd.querySelectorAll(".vpanel .tbtn")].find(b => b.textContent === "Draw a visual").disabled, "one drawing at a time per block");
vw.dispatchEvent(new vw.MessageEvent("message", {data: {type: "visualProgress", key: asked.key, text: "Reading src/a.py", time: "0:04"}}));
assert.ok(vd.querySelector(".vdrawing").textContent.includes("Reading src/a.py · 0:04"));
vw.dispatchEvent(new vw.MessageEvent("message", {data: {type: "visualDone", key: asked.key}}));
assert.ok(!vd.querySelector(".vdrawing"));
// Comments beside a block: the tab shows open ones, the panel adds, marks done and copies them
vw.dispatchEvent(new vw.MessageEvent("message", {data: {type: "render", name: "g.regain.md", blocks: [{kind: "text", src: "# Guide", key: 0}, {kind: "code", src: "x = 1", key: 1}],
  files: {}, outputs: {}, visuals: {}, terms: [], comments: {"code:x = 1": [{id: "a", text: "Use a named constant.", at: "2026-10-03T08:00:00Z", done: false}, {id: "b", text: "Old note.", at: "2026-10-03T07:00:00Z", done: true}]}}}));
assert.strictEqual(vd.querySelector(".ctab .ccount").textContent, "1", "the tab counts open comments");
vd.querySelector(".ctab").click();
assert.deepStrictEqual([...vd.querySelectorAll(".cnote")].map(n => [n.querySelector("p").textContent, n.classList.contains("done")]), [["Use a named constant.", false], ["Old note.", true]]);
const input = vd.querySelector(".cinput");
input.value = "Explain the 0.8 threshold.";
input.dispatchEvent(new vw.Event("input"));
input.dispatchEvent(new vw.KeyboardEvent("keydown", {key: "Enter", metaKey: true}));
assert.deepStrictEqual(posted.at(-1), {type: "addComment", index: 1, text: "Explain the 0.8 threshold."});
[...vd.querySelectorAll(".cnote .tbtn")][0].click();
assert.deepStrictEqual(posted.at(-1), {type: "toggleComment", index: 1, id: "a"});
[...vd.querySelectorAll(".cpanel .vhead .tbtn")][0].click();
assert.deepStrictEqual(posted.at(-1), {type: "copyComments", index: 1});
vd.querySelector(".vtab:not(.ctab)").click();
assert.ok(vd.querySelector(".vpanel:not(.cpanel)") && !vd.querySelector(".cpanel"), "one panel at a time");
vw.close();


console.log("guide views: all passed");
