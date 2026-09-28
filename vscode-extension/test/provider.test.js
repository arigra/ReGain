// Drives NotebookEditor with a stand-in vscode API and a temp project on disk.
const Module = require("module");
const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path");

const state = new Map();
const listeners = {msg: null, docChange: []};
const fake = {
  Uri: {file: p => ({fsPath: p, toString: () => "file://" + p}), joinPath: (u, ...p) => ({fsPath: path.join(u.fsPath, ...p)})},
  Range: class {}, RelativePattern: class {},
  WorkspaceEdit: class { replace(uri, range, text) { this.text = text; } },
  ViewColumn: {One: 1, Two: 2},
  workspace: {
    getConfiguration: () => ({get: () => ""}),
    getWorkspaceFolder: () => null,
    createFileSystemWatcher: () => ({onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {}}),
    onDidChangeTextDocument: f => { listeners.docChange.push(f); return {dispose() {}}; },
    applyEdit: async e => { doc.text = e.text; return true; },
  },
  window: {showOpenDialog: async () => fake.picked, showInformationMessage: () => {}},
  env: {clipboard: {writeText: async t => { fake.clipboard = t; }}},
  commands: {executeCommand: async (...a) => { fake.command = a; }},
  extensions: {getExtension: () => null},
};
const load = Module._load;
Module._load = (req, ...rest) => req === "vscode" ? fake : load(req, ...rest);
const {NotebookEditor} = require("../notebook/provider");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "regain-prov-"));
fs.mkdirSync(path.join(root, ".regain"));
fs.mkdirSync(path.join(root, "src"));
fs.writeFileSync(path.join(root, "src/m.py"), "a = 1\nb = a * 30\nc = 3\n");
fs.writeFileSync(path.join(root, ".regain/bites.json"), JSON.stringify([
  {file: "src/m.py", match: "a * 30", why: "30 sets the peak"},
  {file: "src/m.py", match: "gone()", why: "was here"},
  {file: "src/other.py", match: "x", why: "another file"}]));
const pagePath = path.join(root, ".regain/p.regain.md");
const pageText = "# P\n\n```file src/m.py\n```\n\n```python\nprint(1)\n```\n";
fs.writeFileSync(pagePath, pageText);

const doc = {uri: fake.Uri.file(pagePath), text: pageText, get lineCount() { return this.text.split("\n").length; },
  getText() { return this.text; }, save: async () => true};
const posted = [];
const panel = {viewColumn: 1, onDidDispose() {},
  webview: {options: {}, cspSource: "x", asWebviewUri: u => ({toString: () => "vsc://" + u.fsPath}), postMessage: m => { posted.push(m); },
    onDidReceiveMessage: f => { listeners.msg = f; }}};
const context = {extensionUri: {fsPath: __dirname}, globalState: {get: (k, d) => d, update: async () => {}},
  workspaceState: {get: k => state.get(k), update: async (k, v) => { state.set(k, v); }}};

(async () => {
  new NotebookEditor(context).resolveCustomTextEditor(doc, panel);
  const send = m => listeners.msg(m);
  const last = type => posted.filter(m => m.type === type).pop();

  await send({type: "ready"});
  let f = last("render").files["src/m.py"];
  assert.deepStrictEqual(f.bites.map(b => b.match), ["a * 30", "gone()"], "only this file's red lines");
  assert.deepStrictEqual(f.lostBites.map(b => b.match), ["gone()"]);
  assert.deepStrictEqual([f.changed, f.removed], [[], 0], "first sight: nothing marked");

  // someone else edits the file: the new lines are marked until "Mark as seen"
  fs.writeFileSync(path.join(root, "src/m.py"), "a = 1\nb = a * 30\nnew = 9\n");
  await send({type: "ready"});
  f = last("render").files["src/m.py"];
  assert.deepStrictEqual([f.changed, f.removed], [[3], 1]);
  await send({type: "markSeen", path: "src/m.py"});
  assert.deepStrictEqual(last("annot").content.changed, []);

  // your own save counts as seen
  fs.writeFileSync(path.join(root, "src/m.py"), "a = 2\nb = a * 30\nnew = 9\n");
  await send({type: "writeFile", path: "src/m.py", range: null, text: "a = 3\nb = a * 30\nnew = 9\n"});
  const saved = last("saved");
  assert.ok(saved.ok);
  assert.deepStrictEqual([saved.content.changed, saved.content.removed], [[], 0]);
  assert.strictEqual(fs.readFileSync(path.join(root, "src/m.py"), "utf8"), "a = 3\nb = a * 30\nnew = 9\n");

  // outputs are kept next to the page, by source, and dropped when the block goes away
  await send({type: "saveOutput", src: "print(1)", entry: {outputs: [{kind: "stream", name: "stdout", text: "1\n"}], vars: [], time: "t"}});
  await send({type: "saveOutput", src: "old()", entry: {outputs: [], vars: [], time: "t"}});
  await new Promise(r => setTimeout(r, 700));
  const outFile = path.join(root, ".regain/p.regain.outputs.json");
  const kept = JSON.parse(fs.readFileSync(outFile, "utf8"));
  assert.deepStrictEqual(Object.keys(kept), ["print(1)"]);
  await send({type: "ready"});
  assert.deepStrictEqual(Object.keys(last("render").outputs), ["print(1)"]);

  // visuals: a request for the agent, an image added from disk, and serving it to the page
  await send({type: "copyVisualRequest", index: 1});
  assert.ok(fake.clipboard.includes("the file src/m.py"));
  assert.ok(fake.clipboard.includes("Save it as .regain/visuals/m.svg"));
  assert.ok(fake.clipboard.endsWith("```file src/m.py"), "ends with the fence to extend");
  const pic = path.join(os.tmpdir(), "regain-pic.png");
  fs.writeFileSync(pic, "png");
  fake.picked = [{fsPath: pic}];
  await send({type: "addVisual", index: 1});
  assert.ok(fs.existsSync(path.join(root, ".regain/visuals/regain-pic.png")), "copied next to the page");
  assert.ok(doc.text.includes("```file src/m.py visual=visuals/regain-pic.png"), "linked in the page");
  const vis = last("render").visuals["visuals/regain-pic.png"];
  assert.ok(vis.exists && vis.image && vis.uri.startsWith("vsc://" + path.join(root, ".regain/visuals/regain-pic.png") + "?v="));
  await send({type: "addVisual", index: 1});   // same name again: kept apart
  assert.ok(doc.text.includes("visual=visuals/regain-pic.png,visuals/regain-pic-2.png"));
  await send({type: "copyVisualRequest", index: 1});
  assert.ok(fake.clipboard.includes("visual=visuals/regain-pic.png,visuals/regain-pic-2.png"));
  await send({type: "openVisual", path: "visuals/regain-pic.png"});
  assert.strictEqual(fake.command[0], "vscode.open");
  fs.rmSync(pic);

  fs.rmSync(root, {recursive: true});
  console.log("provider: all passed");
})().catch(e => { console.error(e); process.exit(1); });
