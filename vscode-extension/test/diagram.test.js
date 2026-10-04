// The overview page: story, subjects in reading order, the selected subject, words and questions.
const assert = require("assert");
const {JSDOM} = require("jsdom");
const {semanticDiagram} = require("../semantic-tree-diagram");

const node = (id, extra = {}) => ({id, name: "Name " + id, purpose: "Purpose " + id + " uses RADIal data from data/radial/split.json and radial motion.",
  kind: "code", role: "flow", state: "done", flow: [{id: "s", label: "Step", description: "Reads RADIal frames.", state: "done", sources: ["src/a.py"]}],
  sources: [{path: "src/a.py", reason: "r"}], related: [], children: [], refined: false, ...extra});
const map = {projectName: "Demo", summary: "Demo.", story: {asks: "Does it work?", done: "The RADIal part.", next: "The rest."},
  capabilities: [node("q", {role: "side", kind: "status", state: "in_progress"}), node("a", {refined: true, children: [node("a1"), node("a2", {state: "not_started"})], related: ["b"]}),
    node("b", {state: "unknown"}), node("old", {role: "side", kind: "experiment"})],
  terms: [{term: "RADIal", meaning: "The real radar dataset."}], openQuestions: ["Did the long run finish?"],
  reading: {read: 12, total: 12, unread: [], method: "all"}, uncertainties: ["A technical doubt."]};

function page(m = map, talk = {}) {
  const sent = [];
  const dom = new JSDOM(semanticDiagram(m, talk), {runScripts: "dangerously", pretendToBeVisual: true, beforeParse(w) {
    w.regainApi = {getState: () => ({}), setState: () => {}, postMessage: msg => sent.push(JSON.parse(JSON.stringify(msg)))};
    w.HTMLElement.prototype.scrollIntoView = () => {};
  }});
  dom.window.HTMLFormElement.prototype.requestSubmit = function () { this.dispatchEvent(new dom.window.Event("submit", {cancelable: true})); };
  dom.window.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
  return {dom, d: dom.window.document, sent};
}

{
  const {dom, d, sent} = page(map, {progress: {covered: ["q"], started: []}, notebooks: ["b"], estimates: {detail: 240000, branch: 50000}});
  assert.strictEqual(sent.length, 0, "viewing the page must not launch AI");
  assert.deepStrictEqual([...d.querySelectorAll(".story .label")].map(x => x.textContent), ["Asks", "Done so far", "Next"]);
  assert.ok(d.querySelector(".reading .ok").textContent.includes("Every file was read"));

  // subjects as boxes in reading order: side subjects above and below, arrows between the flow
  const rows = [...d.querySelectorAll(".diagram .row")];
  assert.deepStrictEqual(rows.map(r => [...r.querySelectorAll(".box")].map(b => b.dataset.id)), [["q"], ["a", "b"], ["old"]]);
  assert.strictEqual(rows[1].querySelectorAll(".arrow").length, 1);
  assert.deepStrictEqual([...d.querySelectorAll(".diagram .num")].map(n => n.textContent), ["✓", "2", "3", "4"], "covered subjects get a tick");
  assert.strictEqual(d.querySelector('.box[data-id="a"] .start').textContent, "Next", "the next unread subject is marked");
  assert.strictEqual(d.querySelector('.box[data-id="b"]').dataset.state, "unknown");
  assert.strictEqual(d.querySelectorAll(".legend span").length, 5);
  assert.ok(d.getElementById("search").hidden, "search is hidden for a small map");

  // the first unread subject opens first, and its parts navigate without AI
  assert.strictEqual(d.querySelector(".detail h2").textContent, "Name a");
  assert.strictEqual(d.querySelectorAll(".parts .box").length, 2);
  d.querySelector('.parts .box[data-id="a2"]').click();
  assert.strictEqual(d.querySelector(".detail h2").textContent, "Name a2");
  assert.strictEqual(d.querySelector(".crumb button").textContent, "Name a");
  assert.strictEqual(sent.length, 0, "showing saved parts must not launch AI");
  d.querySelector(".crumb button").click();

  // actions are named by what you get, with the usual time
  const buttons = () => [...d.querySelectorAll(".detail .actions button")];
  assert.ok(buttons()[0].textContent.startsWith("Guide me through this") && buttons()[0].textContent.includes("about 4 min"));
  buttons()[0].click();
  assert.deepStrictEqual(sent.at(-1), {type: "analyzeCapability", id: "a"});
  d.querySelector('.box[data-id="b"]').click();
  assert.deepStrictEqual(buttons().map(b => b.firstChild.textContent), ["Open its guide", "Write a fresh guide", "Split into parts"]);
  buttons()[0].click();
  assert.deepStrictEqual(sent.at(-1), {type: "openGuide", id: "b"});
  buttons()[2].click();
  assert.deepStrictEqual(sent.at(-1), {type: "expandCapability", id: "b"});

  // "I've got this" marks the path
  d.querySelector(".detail .toggle").click();
  assert.deepStrictEqual(sent.at(-1), {type: "markCovered", id: "b", covered: true});
  assert.strictEqual(d.querySelector('.box[data-id="b"] .num').textContent, "✓");

  // connected subjects are one click away
  d.querySelector('.box[data-id="a"]').click();
  d.querySelector(".related .chip").click();
  assert.strictEqual(d.querySelector(".detail h2").textContent, "Name b");

  // words: hover text on the term in exact case, never on ordinary words or inside paths
  const termed = [...d.querySelectorAll(".detail .lead .term")].map(t => t.textContent);
  assert.deepStrictEqual(termed, ["RADIal"]);
  assert.strictEqual(d.querySelector(".detail .lead .term").title, "The real radar dataset.");
  assert.ok(d.querySelector("#terms dl").textContent.includes("The real radar dataset."));

  // open questions go to the chat
  d.querySelector(".questions .link").click();
  assert.ok(d.getElementById("askText").value.startsWith('About "Did the long run finish?"'));
  assert.ok(d.querySelector(".uncertain summary").textContent.includes("Technical notes"));
  dom.window.close();
}

{
  // a large map shows search, which dims the subjects that do not match
  const many = {...map, capabilities: Array.from({length: 14}, (_, i) => node("n" + i, {name: i === 3 ? "Fit the simulator" : "Subject " + i, purpose: "p"}))};
  const {dom, d} = page(many);
  const search = d.getElementById("search");
  assert.ok(!search.hidden);
  search.value = "simulator";
  search.dispatchEvent(new dom.window.Event("input"));
  assert.strictEqual(d.querySelectorAll(".diagram .box:not(.dim)").length, 1);
  dom.window.close();
}

{
  // an old map without the new fields still draws
  const old = {projectName: "Old", summary: "An old map.", capabilities: [{id: "x", name: "X", purpose: "p", flow: [], sources: [], related: [], children: []}], uncertainties: []};
  const {dom, d} = page(old);
  assert.strictEqual(d.querySelector(".story p").textContent, "An old map.");
  assert.strictEqual(d.querySelector(".box").dataset.state, "unknown");
  assert.ok(d.getElementById("questions").hidden && d.getElementById("terms").hidden);
  dom.window.close();
}

console.log("Diagram interactions passed");
