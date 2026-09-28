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
  $(".code .runbtn").click();
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
  $(".code .runbtn").click();
  const run2 = sent.filter(m => m.type === "run")[1];
  send({type: "runStarted", id: 8, key: run2.key});
  send({type: "kernel", ev: {id: 8, type: "error", traceback: ["\x1b[0;31mNameError\x1b[0m: x"]}});
  send({type: "kernel", ev: {id: 8, type: "done", status: "error"}});
  assert.strictEqual($(".code .out .error").textContent, "NameError: x\n");

  // editing a code block saves the page; a file block is written only when run (saved)
  const codeTa = $(".code textarea"); codeTa.value = "print(2)"; codeTa.dispatchEvent(new w.Event("input"));
  const fileTa = $(".file textarea"); fileTa.value = "def f():\n    return 2\n"; fileTa.dispatchEvent(new w.Event("input"));
  assert.strictEqual($(".file .nums").textContent, "1\n2\n3");
  await new Promise(r => setTimeout(r, 500));
  const set = sent.filter(m => m.type === "setBlocks").pop();
  assert.strictEqual(set.blocks[2].src, "print(2)");
  assert.ok(!("key" in set.blocks[2]), "keys stay in the view");
  assert.ok(!sent.some(m => m.type === "writeFile"), "typing does not save the file");
  assert.strictEqual($(".file .state").textContent, "● Unsaved changes · ▶ to save");
  assert.ok($(".blk.file").classList.contains("dirty"), "unsaved file changes colour");
  assert.strictEqual($(".unsaved").textContent, "● 1 unsaved file");
  assert.ok(!$(".unsaved").hidden);

  // a change on disk does not overwrite unsaved edits
  send({type: "file", path: "src/data.py", content: {text: "from disk", start: 1}});
  assert.strictEqual($(".file textarea").value, "def f():\n    return 2\n");
  assert.strictEqual($(".file .state").textContent, "● Unsaved changes · file changed on disk");

  // running code while a file is unsaved warns in that code block
  $(".code .runbtn").click();
  const run3 = sent.filter(m => m.type === "run").pop();
  assert.ok($(".code .out .warn").textContent.startsWith("⚠ Unsaved changes in src/data.py"));
  send({type: "runStarted", id: 10, key: run3.key});
  send({type: "kernel", ev: {id: 10, type: "done", status: "ok"}});

  // ▶ on a file block saves it
  $(".file .runbtn").click();
  const wf = sent.find(m => m.type === "writeFile");
  assert.deepStrictEqual(wf, {type: "writeFile", path: "src/data.py", range: null, text: "def f():\n    return 2\n"});
  assert.strictEqual($(".file .state").textContent, "");
  assert.ok(!$(".blk.file").classList.contains("dirty"));
  assert.ok($(".unsaved").hidden);
  assert.strictEqual($(".file .count").textContent, "[*]");
  send({type: "saved", path: "src/data.py", ok: true, lines: 3});
  assert.strictEqual($(".file .count").textContent, "[✓]");
  assert.ok($(".file .out.saved").textContent.startsWith("✓ Saved src/data.py · 3 lines"));

  // running an unchanged file still saves and shows a result
  const before = sent.filter(m => m.type === "writeFile").length;
  $(".file .runbtn").click();
  assert.strictEqual(sent.filter(m => m.type === "writeFile").length, before + 1);
  send({type: "saved", path: "src/data.py", ok: false, error: "EACCES"});
  assert.strictEqual($(".file .count").textContent, "[!]");
  assert.ok($(".file .out .error").textContent.includes("Could not save src/data.py: EACCES"));
  assert.ok($(".blk.file").classList.contains("dirty"), "a failed save stays unsaved");

  // typing back to the saved text clears the unsaved state
  $(".file .runbtn").click();
  send({type: "saved", path: "src/data.py", ok: true, lines: 3});
  assert.ok(!$(".blk.file").classList.contains("dirty"), "a retried save clears it");
  const back = $(".file textarea"); const saved = back.value;
  back.value = saved + "x"; back.dispatchEvent(new w.Event("input"));
  assert.ok($(".blk.file").classList.contains("dirty"));
  back.value = saved; back.dispatchEvent(new w.Event("input"));
  assert.ok(!$(".blk.file").classList.contains("dirty"));

  // Shift+Enter in a file block saves too
  const fta = $(".file textarea"); fta.value = "v3"; fta.dispatchEvent(new w.Event("input"));
  fta.dispatchEvent(new w.KeyboardEvent("keydown", {key: "Enter", shiftKey: true, bubbles: true}));
  assert.strictEqual(sent.filter(m => m.type === "writeFile").pop().text, "v3");

  // Run all saves unsaved files, then queues the code blocks
  const fta2 = $(".file textarea"); fta2.value = "v4"; fta2.dispatchEvent(new w.Event("input"));
  [...w.document.querySelectorAll(".tbtn")].find(b => b.textContent.includes("Run all")).click();
  assert.strictEqual(sent.filter(m => m.type === "writeFile").pop().text, "v4");
  const lastRun = sent.filter(m => m.type === "run").pop();
  send({type: "runStarted", id: 9, key: lastRun.key});
  send({type: "kernel", ev: {id: 9, type: "stream", name: "stdout", text: "kept\n"}});
  send({type: "kernel", ev: {id: 9, type: "done", status: "ok"}});

  // the kernel picker shows the interpreter and asks the extension to choose
  send({type: "kernel", ev: {type: "status", state: "idle", python: "/a/anaconda3/bin/python", label: "anaconda3", version: "3.11.5"}});
  assert.ok($(".kpick").textContent.includes("anaconda3 (Python 3.11.5)"));
  $(".kpick").click();
  assert.deepStrictEqual(sent.pop(), {type: "pickKernel"});

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
  assert.strictEqual($(".code .out").textContent, "kept\n");
  assert.strictEqual(w.document.documentElement.style.getPropertyValue("--file"), "#ff0000");

  // a fatal kernel error shows a banner and clears the queue
  send({type: "kernel", ev: {type: "fatal", message: "Could not start python3"}});
  assert.strictEqual($(".banner").textContent, "Could not start python3");
  assert.ok($(".kstate").className.includes("dead"));
  console.log("view: all passed");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
