const {JSDOM} = require("jsdom");
const fs = require("fs");
const assert = require("assert");
const src = fs.readFileSync(__dirname + "/../media/notebook.js", "utf8");
const dom = new JSDOM(`<body class="vscode-dark"><div id="app"></div></body>`, {runScripts: "outside-only", pretendToBeVisual: true});
const w = dom.window, sent = [];
w.acquireVsCodeApi = () => ({postMessage: m => sent.push(JSON.parse(JSON.stringify(m)))});
w.HTMLCanvasElement.prototype.getContext = () => ({set fillStyle(v) { this._v = v; }, get fillStyle() { return "#123456"; }});
w.CSS = {escape: s => s};
w.scrollTo = () => {};
w.eval(src);
const send = m => w.dispatchEvent(new w.MessageEvent("message", {data: m}));
const tick = () => new Promise(r => setTimeout(r, 30));
const $ = s => w.document.querySelector(s), $$ = s => [...w.document.querySelectorAll(s)];

(async () => {
  assert.deepStrictEqual(sent[0], {type: "ready"});
  assert.strictEqual(w.document.documentElement.dataset.theme, "dark");
  send({type: "render", name: "demo.regain.md", root: "/r", colors: {},
    blocks: [{kind: "text", src: "## 1 · Data\nRead a `frame`."},
             {kind: "file", path: "src/data.py", range: null},
             {kind: "code", src: "from src.data import f\nf()"},
             {kind: "file", path: "src/new.py", range: null}],
    files: {"src/data.py": {text: "def f():\n    return 1", start: 1}, "src/new.py": {missing: true}}});
  assert.strictEqual($(".text h2").textContent, "1 · Data");
  assert.strictEqual($(".text code").textContent, "frame");
  assert.strictEqual($(".file .path").textContent, "src/data.py");
  assert.strictEqual($(".file .nums").textContent, "1\n2");
  assert.ok($$(".missing")[0].textContent.includes("does not exist"));

  // run a code block and feed kernel events back
  $(".runbtn").click();
  const run = sent.find(m => m.type === "run");
  assert.strictEqual(run.code, "from src.data import f\nf()");
  assert.strictEqual($(".code .count").textContent, "[*]");
  send({type: "runStarted", id: 7, key: run.key});
  send({type: "kernel", ev: {id: 7, type: "count", count: 1}});
  send({type: "kernel", ev: {id: 7, type: "stream", name: "stdout", text: "a"}});
  send({type: "kernel", ev: {id: 7, type: "stream", name: "stdout", text: "b\n"}});
  send({type: "kernel", ev: {id: 7, type: "result", data: {"text/plain": "1"}}});
  send({type: "kernel", ev: {id: 7, type: "done", status: "ok"}});
  assert.strictEqual($(".code .count").textContent, "[1]");
  assert.strictEqual($(".code .out").textContent, "ab\n1\n");

  // errors show the traceback without ANSI codes
  $(".runbtn").click();
  const run2 = sent.filter(m => m.type === "run")[1];
  send({type: "runStarted", id: 8, key: run2.key});
  send({type: "kernel", ev: {id: 8, type: "error", traceback: ["\x1b[0;31mNameError\x1b[0m: x"]}});
  send({type: "kernel", ev: {id: 8, type: "done", status: "error"}});
  assert.strictEqual($(".code .out .error").textContent, "NameError: x\n");

  // editing a code block saves the page; editing a file block writes the file
  const codeTa = $(".code textarea"); codeTa.value = "print(2)"; codeTa.dispatchEvent(new w.Event("input"));
  const fileTa = $(".file textarea"); fileTa.value = "def f():\n    return 2\n"; fileTa.dispatchEvent(new w.Event("input"));
  assert.strictEqual($(".file .nums").textContent, "1\n2\n3");
  await new Promise(r => setTimeout(r, 500));
  const set = sent.filter(m => m.type === "setBlocks").pop();
  assert.strictEqual(set.blocks[2].src, "print(2)");
  assert.ok(!("key" in set.blocks[2]), "keys stay in the view");
  const wf = sent.find(m => m.type === "writeFile");
  assert.deepStrictEqual(wf, {type: "writeFile", path: "src/data.py", range: null, text: "def f():\n    return 2\n"});

  // add a code block at the end, move it up, delete it
  $$(".add.last button")[2].click();
  assert.strictEqual($$(".blk").length, 5);
  $$(".blk")[4].querySelector('[title="Move up"]').click();
  assert.ok($$(".blk")[3].classList.contains("code"));
  $$(".blk")[3].querySelector('[title="Delete"]').click();
  assert.strictEqual($$(".blk").length, 4);
  // + File asks the extension for a path
  $$(".add.last button")[1].click();
  assert.deepStrictEqual(sent.pop(), {type: "addFile", at: 4});

  // outputs survive a re-render with the same blocks
  send({type: "render", name: "demo.regain.md", root: "/r", colors: {file: "#ff0000"},
    blocks: [{kind: "text", src: "## 1 · Data\nRead a `frame`."}, {kind: "file", path: "src/data.py", range: null},
             {kind: "code", src: "print(2)"}, {kind: "file", path: "src/new.py", range: null}],
    files: {"src/data.py": {text: "x", start: 1}, "src/new.py": {missing: true}}});
  assert.ok($(".code .out").textContent.includes("NameError"));
  assert.strictEqual(w.document.documentElement.style.getPropertyValue("--file"), "#ff0000");

  // a fatal kernel error shows a banner and clears the queue
  send({type: "kernel", ev: {type: "fatal", message: "Could not start python3"}});
  assert.strictEqual($(".banner").textContent, "Could not start python3");
  assert.ok($(".kstate").className.includes("dead"));
  console.log("view: all passed");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
