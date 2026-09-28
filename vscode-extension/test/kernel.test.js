// Runs kernel.js against a real kernel, with a stand-in for the vscode module.
const Module = require("module");
const assert = require("assert");
const python = process.env.REGAIN_PYTHON || "python3";
const fake = {workspace: {getConfiguration: () => ({get: () => python})}, extensions: {getExtension: () => null}};
const load = Module._load;
Module._load = (req, ...rest) => req === "vscode" ? fake : load(req, ...rest);
const {Kernel} = require("../notebook/kernel");

(async () => {
  const events = [];
  let waiters = [];
  const k = new Kernel(process.cwd(), null, ev => { events.push(ev); waiters.forEach(w => w()); });
  const until = pred => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout: " + JSON.stringify(events.slice(-3)))), 60000);
    const check = () => { if (pred()) { clearTimeout(t); res(); } };
    waiters.push(check); check();
  });
  const doneOf = id => until(() => events.some(e => e.type === "done" && e.id === id));

  const a = await k.exec("x = 40\nprint('hi')\nx + 2");
  await doneOf(a);
  assert.ok(events.some(e => e.id === a && e.type === "stream" && e.text === "hi\n"));
  assert.ok(events.some(e => e.id === a && e.type === "result" && e.data["text/plain"] === "42"));

  // an edited module is picked up without restarting the kernel
  const fs = require("fs"), os = require("os"), path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "regain-"));
  fs.writeFileSync(path.join(dir, "mod_ar.py"), "def f():\n    return 1\n");
  const r1 = await k.exec(`import sys; sys.path.insert(0, ${JSON.stringify(dir)})\nfrom mod_ar import f\nf()`);
  await doneOf(r1);
  assert.ok(events.some(e => e.id === r1 && e.type === "result" && e.data["text/plain"] === "1"));
  await new Promise(r => setTimeout(r, 1100));   // new mtime
  fs.writeFileSync(path.join(dir, "mod_ar.py"), "def f():\n    return 2\n");
  const r2 = await k.exec("f()");
  await doneOf(r2);
  assert.ok(events.some(e => e.id === r2 && e.type === "result" && e.data["text/plain"] === "2"), "autoreload");
  assert.ok(events.some(e => e.type === "status" && e.state === "idle" && /^\d+\.\d+/.test(e.version)), "reports version");

  const b = await k.exec("undefined_name");
  await doneOf(b);
  assert.ok(events.some(e => e.id === b && e.type === "error" && e.ename === "NameError"));

  const c = await k.exec("import time\nfor _ in range(200): time.sleep(0.05)");
  setTimeout(() => k.interrupt(), 1500);
  await doneOf(c);
  assert.ok(events.some(e => e.id === c && e.ename === "KeyboardInterrupt"));

  await k.restart();
  await until(() => events.filter(e => e.type === "status" && e.state === "idle").length >= 2);
  const d = await k.exec("'x' in dir()");
  await doneOf(d);
  assert.ok(events.some(e => e.id === d && e.type === "result" && e.data["text/plain"] === "False"), "restart clears state");

  k.dispose();
  console.log("kernel: all passed");
  setTimeout(() => process.exit(0), 3500);
})().catch(e => { console.error(e); process.exit(1); });
