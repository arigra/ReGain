const {JSDOM} = require("jsdom");
const fs = require("fs");
const assert = require("assert");
const src = fs.readFileSync(__dirname + "/../media/notebook.js", "utf8");
const dom = new JSDOM(`<body class="vscode-dark"><div id="app"></div></body>`, {runScripts: "outside-only", pretendToBeVisual: true});
const w = dom.window, sent = [];
let wstate;
w.acquireVsCodeApi = () => ({postMessage: m => sent.push(JSON.parse(JSON.stringify(m))),
  getState: () => wstate, setState: v => { wstate = JSON.parse(JSON.stringify(v)); }});
w.HTMLCanvasElement.prototype.getContext = () => ({set fillStyle(v) { this._v = v; }, get fillStyle() { return "#123456"; }});
w.CSS = {escape: s => s};
w.scrollTo = () => {};
w.eval(src);
const send = m => {
  if (m.type === "render") {
    for (const [path, f] of Object.entries(m.files || {})) {
      if (f.ranges) continue;
      const whole = {...f};
      f.ranges = {};
      for (const b of m.blocks.filter(b => b.kind === "file" && b.path === path)) {
        const key = b.range ? b.range.join("-") : "all";
        f.ranges[key] = f.missing ? {...whole} : {...whole,
          text: b.range ? whole.text.split("\n").slice(b.range[0] - 1, b.range[1]).join("\n") : whole.text,
          start: b.range ? b.range[0] : 1};
      }
    }
  }
  w.dispatchEvent(new w.MessageEvent("message", {data: m}));
  if (m.type === "render") {
    for (const button of w.document.querySelectorAll(".file-toggle"))
      if (button.textContent === "Expand source") button.click();
  }
};
const tick = () => new Promise(r => setTimeout(r, 30));
const numsOf = sel => [...w.document.querySelectorAll(sel + " .nums .n")].map(n => n.textContent).join("\n");
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
  assert.strictEqual(numsOf(".file"), "1\n2");
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
  assert.strictEqual(numsOf(".file"), "1\n2\n3");
  await new Promise(r => setTimeout(r, 500));
  const set = sent.filter(m => m.type === "setBlocks").pop();
  assert.strictEqual(set.blocks[2].src, "print(2)");
  assert.ok(!("key" in set.blocks[2]), "keys stay in the view");
  assert.ok(!sent.some(m => m.type === "writeFile"), "typing does not save the file");
  assert.strictEqual($(".file .state").textContent, "● Unsaved changes · ▶ to save");
  assert.ok($(".blk.file").classList.contains("dirty"), "unsaved file changes colour");
  assert.strictEqual($(".unsaved").textContent, "● 1 unsaved file · 1 block changed since run");
  assert.ok($(".blk.code").classList.contains("stale"), "edited code turns orange");
  assert.ok(!$(".code .stale-note").hidden);
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
  assert.ok(!$(".blk.code").classList.contains("stale"), "the warning run cleared it");
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

  // editing after a run marks it, running again clears it; a never-run block stays neutral
  const cta = $(".code textarea"); cta.value = "print(3)"; cta.dispatchEvent(new w.Event("input"));
  assert.ok($(".blk.code").classList.contains("stale"));
  assert.strictEqual($(".unsaved").textContent, "● 1 block changed since run");
  $(".code .runbtn").click();
  assert.ok(!$(".blk.code").classList.contains("stale"));
  const run4 = sent.filter(m => m.type === "run").pop();
  send({type: "runStarted", id: 11, key: run4.key});
  send({type: "kernel", ev: {id: 11, type: "stream", name: "stdout", text: "kept\n"}});
  send({type: "kernel", ev: {id: 11, type: "done", status: "ok"}});

  // add a code block at the end, move it up, delete it
  $$(".add.last button")[2].click();
  assert.strictEqual($$(".blk").length, 5);
  const fresh = $$(".blk.code").pop().querySelector("textarea");
  fresh.value = "x = 1"; fresh.dispatchEvent(new w.Event("input"));
  assert.ok(!$$(".blk.code").pop().classList.contains("stale"), "never run: not marked");
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
             {kind: "code", src: "print(3)"}, {kind: "file", path: "src/new.py", range: null}],
    files: {"src/data.py": {text: "x", start: 1}, "src/new.py": {missing: true}}});
  assert.strictEqual($(".code .out").textContent, "kept\n");
  assert.strictEqual(w.document.documentElement.style.getPropertyValue("--file"), "#ff0000");

  // a fatal kernel error shows a banner and clears the queue
  send({type: "kernel", ev: {type: "fatal", message: "Could not start python3"}});
  assert.strictEqual($(".banner").textContent, "Could not start python3");
  assert.ok($(".kstate").className.includes("dead"));
  // highlighting: the textarea is transparent over a coloured copy of the text
  send({type: "render", name: "h.regain.md", root: "/r", colors: {},
    blocks: [{kind: "file", path: "src/m.py", range: null}, {kind: "code", src: "x = f(2)  # go"}],
    files: {"src/m.py": {text: "import os\n\ndef f(n):\n    return n * 30\n", start: 1,
      bites: [{match: "n * 30", why: "30 sets the peak"}, {match: "gone()", why: "was here"}],
      lostBites: [{match: "gone()", why: "was here"}], changed: [3], removed: 1}}});
  assert.ok($(".file textarea").classList.contains("over"));
  assert.strictEqual($(".file .hl .kw").textContent, "import");
  assert.strictEqual($(".file .hl .fn").textContent, "f");
  assert.strictEqual($(".code .hl .cm").textContent, "# go");
  assert.strictEqual($(".code .hl .nu").textContent, "2");
  assert.strictEqual($$(".file .hl .l").length, 5, "one overlay line per text line");

  // Important lines are marked in the source and line numbers.
  const hlLines = $$(".file .hl .l");
  assert.ok(hlLines[3].classList.contains("importance-critical"));
  assert.strictEqual($$(".file .nums .n")[3].getAttribute("title"), "Critical: 30 sets the peak");

  // Changes since you last looked retain their own mark.
  assert.ok(hlLines[2].classList.contains("chg"));

  // The line mark follows its text while you type.
  const mta = $(".file textarea");
  mta.value = "# top\n" + mta.value; mta.dispatchEvent(new w.Event("input"));
  assert.ok($$(".file .hl .l")[4].classList.contains("importance-critical"));

  // variables from a run, and the output kept next to the page
  $(".code .runbtn").click();
  const rv = sent.filter(m => m.type === "run").pop();
  send({type: "runStarted", id: 20, key: rv.key});
  send({type: "kernel", ev: {id: 20, type: "stream", name: "stdout", text: "hi\n"}});
  send({type: "kernel", ev: {id: 20, type: "vars", vars: [{name: "x", type: "ndarray", info: "(64, 32) float64"}]}});
  send({type: "kernel", ev: {id: 20, type: "done", status: "ok"}});
  assert.strictEqual($(".vars").textContent, "x ndarray (64, 32) float64");
  const so = sent.filter(m => m.type === "saveOutput").pop();
  assert.strictEqual(so.src, "x = f(2)  # go");
  assert.deepStrictEqual(so.entry.vars, [{name: "x", type: "ndarray", info: "(64, 32) float64"}]);
  assert.deepStrictEqual(so.entry.outputs, [{kind: "stream", name: "stdout", text: "hi\n"}]);

  // a fresh view restores it, marked as from an earlier session
  send({type: "render", name: "h2.regain.md", root: "/r", colors: {}, files: {},
    blocks: [{kind: "text", src: "# other"}], outputs: {}});
  send({type: "render", name: "h.regain.md", root: "/r", colors: {}, files: {},
    blocks: [{kind: "code", src: "x = f(2)  # go"}], outputs: {"x = f(2)  # go": so.entry}});
  assert.ok($(".code .restored").textContent.startsWith("Output from "));
  assert.ok($(".code .out").textContent.includes("hi"));
  assert.strictEqual($(".vars").textContent, "x ndarray (64, 32) float64");

  // a visual panel on the right of file and code blocks
  send({type: "render", name: "v.regain.md", root: "/r", colors: {}, outputs: {},
    blocks: [{kind: "text", src: "## T"}, {kind: "file", path: "src/m.py", range: null, visual: ["visuals/m.svg"]},
             {kind: "code", src: "y = 1"}],
    files: {"src/m.py": {text: "a = 1", start: 1}},
    visuals: {"visuals/m.svg": {exists: true, image: true, uri: "vsc://m.svg?v=1"}}});
  assert.strictEqual($$(".vtab").length, 2, "file and code blocks only");
  assert.ok($(".file .vtab").classList.contains("has") && !$(".code .vtab").classList.contains("has"));
  $(".file .vtab").click();
  assert.ok($(".blk.file").classList.contains("vopen"));
  assert.strictEqual($(".vfig img").getAttribute("src"), "vsc://m.svg?v=1");
  $(".vfig figcaption .tbtn").click();
  assert.deepStrictEqual(sent.pop(), {type: "openVisual", path: "visuals/m.svg"});
  const vbtns = [...w.document.querySelectorAll(".vhead .tbtn")];
  vbtns[0].click();
  assert.deepStrictEqual(sent.pop(), {type: "copyVisualRequest", index: 1});
  vbtns[1].click();
  assert.deepStrictEqual(sent.pop(), {type: "addVisual", index: 1});
  [...w.document.querySelectorAll(".vfig figcaption .tbtn")].pop().click();   // unlink
  const unlinked = sent.filter(m => m.type === "setBlocks").pop();
  assert.ok(!("visual" in unlinked.blocks[1]), "unlinked, and the fence loses visual=");
  assert.ok($(".vempty").textContent.startsWith("Nothing here yet"));
  $(".code .vtab").click();
  assert.strictEqual($$(".vpanel").length, 2);
  $(".file .vtab").click();
  assert.ok(!$(".blk.file").classList.contains("vopen"));

  // collapsing a heading hides what is under it, down to the next heading of its level
  send({type: "render", name: "c.regain.md", root: "/r", colors: {},
    blocks: [{kind: "text", src: "# Top\nintro"}, {kind: "text", src: "## A\nabout A"},
             {kind: "code", src: "a = 1"}, {kind: "text", src: "## B"}, {kind: "code", src: "b = 2"}],
    files: {}});
  assert.strictEqual($$(".fold").length, 3);
  $$(".fold")[1].click();                                   // collapse A
  assert.strictEqual($$(".blk").length, 4, "A's code is hidden");
  assert.ok(!$$(".blk.text")[1].textContent.includes("about A"), "only the heading line shows");
  assert.strictEqual($$(".hidden-note")[0].textContent, "1 block hidden");
  assert.strictEqual($$(".fold")[1].textContent, "▸");
  assert.deepStrictEqual(wstate.collapsed, ["## A"]);
  $$(".fold")[0].click();                                   // collapse Top: hides everything under it
  assert.strictEqual($$(".blk").length, 1);
  assert.strictEqual($(".hidden-note").textContent, "4 blocks hidden");
  $(".hidden-note").click();                                // expand Top again; A stays collapsed
  assert.strictEqual($$(".blk").length, 4);
  $$(".fold")[1].click();                                   // expand A
  assert.strictEqual($$(".blk").length, 5);
  assert.deepStrictEqual(wstate.collapsed, []);

  console.log("view: all passed");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
