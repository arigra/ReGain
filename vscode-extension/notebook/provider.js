// Custom editor for *.regain.md: headings, file blocks and code blocks.
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const {spawn} = require("child_process");
const {parse, serialize} = require("./format");
const {Kernel, pythonFor} = require("./kernel");
const {lineChanges} = require("./diff");

const COLORS_KEY = "regain.colors";

// A .regain.md inside .regain/ belongs to the project one level up.
function projectRoot(uri) {
  const dir = path.dirname(uri.fsPath);
  if (path.basename(dir) === ".regain") return path.dirname(dir);
  const ws = vscode.workspace.getWorkspaceFolder(uri);
  return ws ? ws.uri.fsPath : dir;
}

// A short name for an interpreter: the conda env, the venv, or its folder.
// Handles both /env/bin/python and C:\env\Scripts\python.exe (or C:\env\python.exe).
function envLabel(python) {
  const parts = python.split(/[\\/]/).filter(Boolean);
  const envs = parts.lastIndexOf("envs");
  if (envs >= 0 && parts[envs + 1]) return parts[envs + 1];
  const bin = Math.max(parts.lastIndexOf("bin"), parts.lastIndexOf("Scripts"));
  if (bin > 0) return parts[bin - 1];
  return parts.length > 1 ? parts[parts.length - 2] : python;
}

// Same file? On Windows VS Code reports "c:\..." where path.resolve gives "C:\...".
function samePath(a, b) {
  const norm = p => process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);
  return norm(a) === norm(b);
}

// Files are shown and diffed with "\n"; a file that used "\r\n" is written back with it.
function readText(full) {
  const raw = fs.readFileSync(full, "utf8");
  return {text: raw.replace(/\r\n/g, "\n"), eol: raw.includes("\r\n") ? "\r\n" : "\n"};
}
function writeText(full, text, eol) {
  fs.writeFileSync(full, eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text);
}
const posix = p => p.split(path.sep).join("/");

async function knownPythons() {
  try {
    const ext = vscode.extensions.getExtension("ms-python.python");
    if (!ext) return [];
    const api = ext.isActive ? ext.exports : await ext.activate();
    return api.environments.known.map(e => {
      const v = e.version;
      return {path: e.path, version: v && v.major != null ? `${v.major}.${v.minor}.${v.micro}` : ""};
    });
  } catch { return []; }
}

function readFileBlock(root, b) {
  const full = path.resolve(root, b.path);
  if (!fs.existsSync(full)) return {missing: true};
  const {text} = readText(full);
  if (!b.range) return {text, start: 1};
  const lines = text.split("\n");
  return {text: lines.slice(b.range[0] - 1, b.range[1]).join("\n"), start: b.range[0]};
}

class NotebookEditor {
  constructor(context) {
    this.context = context;
  }

  resolveCustomTextEditor(document, panel) {
    const root = projectRoot(document.uri);
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    const pageDir = path.dirname(document.uri.fsPath);
    panel.webview.options = {enableScripts: true, localResourceRoots: [media, vscode.Uri.file(pageDir)]};
    panel.webview.html = this.html(panel.webview, media);

    let blocks = parse(document.getText());
    let selfEdit = 0;                 // document changes we made ourselves
    const selfWrites = new Map();     // file path -> text we just wrote
    const post = msg => panel.webview.postMessage(msg);

    // Red lines: .regain/bites.json lists {file, match, why}. A line is found by
    // a piece of its text, so it survives edits above it; a lost match is reported.
    const bitesPath = path.join(root, ".regain", "bites.json");
    const loadBites = () => {
      try { return JSON.parse(fs.readFileSync(bitesPath, "utf8")); } catch { return []; }
    };
    let bites = loadBites();
    const importancePath = path.join(root, ".regain", "line-importance.json");
    const loadImportance = () => {
      try { return JSON.parse(fs.readFileSync(importancePath, "utf8")); }
      catch { return {}; }
    };
    let importanceData = loadImportance();
    let importance = importanceData.files || {};
    let cellImportance = importanceData.cells || {};

    // What each file looked like when you last saw it (first shown, saved here, or "Mark as seen").
    const ws = this.context.workspaceState;
    const seenKey = full => "regain.seen:" + full;

    const fileInfo = b => {
      const c = readFileBlock(root, b);
      if (c.missing) return c;
      const full = path.resolve(root, b.path);
      const whole = readText(full).text;
      const lines = whole.split("\n");
      const [lo, hi] = b.range || [1, lines.length];
      // The view finds the lines itself (they move while you type); here we only
      // report matches that are gone from the whole file.
      c.bites = []; c.lostBites = [];
      for (const x of bites) {
        if (!x.file || !samePath(path.resolve(root, x.file), full) || !x.match) continue;
        const bite = {match: x.match, why: x.why || "", importance: ["critical", "important", "supporting"].includes(x.importance) ? x.importance : "critical"};
        c.bites.push(bite);
        if (!whole.includes(x.match)) c.lostBites.push(bite);
      }
      const plan = importance[b.path];
      if (plan && crypto.createHash("sha256").update(whole).digest("hex") === plan.sha256) {
        c.lineImportance = plan.lines;
        c.lineReasons = plan.reasons || [];
        c.lineConfidence = plan.confidence || [];
      }
      const seen = ws.get(seenKey(full));
      c.changed = []; c.removed = 0;
      if (seen == null) ws.update(seenKey(full), whole);
      else if (seen !== whole) {
        const d = lineChanges(seen, whole);
        c.changed = d.changed.map(i => i + 1).filter(n => n >= lo && n <= hi);
        c.removed = d.removed;
      }
      return c;
    };
    const rangeKey = range => range ? range.join("-") : "all";
    const files = () => {
      const out = {};
      for (const b of blocks) if (b.kind === "file" && b.path) {
        if (!out[b.path]) out[b.path] = {...fileInfo({path: b.path, range: null}), ranges: {}};
        out[b.path].ranges[rangeKey(b.range)] = fileInfo(b);
      }
      return out;
    };

    // Outputs of code blocks, kept next to the page and matched by source.
    const outPath = document.uri.fsPath.replace(/\.md$/, "") + ".outputs.json";
    let savedOut = {};
    try { savedOut = JSON.parse(fs.readFileSync(outPath, "utf8")); } catch { /* none yet */ }
    let outTimer = null;
    const writeOutputs = () => {
      clearTimeout(outTimer);
      outTimer = setTimeout(() => {
        const live = new Set(blocks.filter(b => b.kind === "code").map(b => b.src));
        for (const k of Object.keys(savedOut)) if (!live.has(k)) delete savedOut[k];
        try { fs.writeFileSync(outPath, JSON.stringify(savedOut, null, 1)); } catch { /* read-only */ }
      }, 500);
    };

    // Pictures that explain a block (visual= on its fence), relative to the page's folder.
    const IMAGE = /\.(svg|png|jpe?g|gif|webp)$/i;
    const visuals = () => {
      const out = {};
      for (const b of blocks) for (const v of b.visual || []) {
        const full = path.resolve(pageDir, v);
        const exists = fs.existsSync(full);
        const stamp = exists ? fs.statSync(full).mtimeMs : 0;       // reload when it is redrawn
        out[v] = {exists, image: IMAGE.test(v),
          uri: exists ? panel.webview.asWebviewUri(vscode.Uri.file(full)).toString() + "?v=" + stamp : null};
      }
      return out;
    };
    const fence = b => serialize([b]).split("\n")[0];
    const visualRequest = i => {
      const b = blocks[i];
      const pageRel = posix(path.relative(root, document.uri.fsPath));
      const dirRel = posix(path.relative(root, pageDir));
      const n = blocks.slice(0, i + 1).filter(x => x.kind === b.kind).length;
      const base = b.kind === "file"
        ? path.basename(b.path).replace(/\.[^.]+$/, "") + (b.range ? `-${b.range[0]}-${b.range[1]}` : "")
        : path.basename(document.uri.fsPath).replace(/\.regain\.md$/, "") + "-block" + n;
      let name = `visuals/${base}.svg`;
      for (let k = 2; (b.visual || []).includes(name) || fs.existsSync(path.resolve(pageDir, name)); k++) name = `visuals/${base}-${k}.svg`;
      const target = b.kind === "file"
        ? `the file ${b.path}${b.range ? ` (lines ${b.range[0]}-${b.range[1]})` : ""}`
        : `this code block from ${pageRel}:\n\n${b.src}\n`;
      return [
        `Make a visual that explains what ${target} does, so I can come back to it later or explain it to someone else.`,
        `A clear diagram (the flow, what goes in and out, the shapes of the data) rather than a chart of made-up numbers. Mark anything you are not sure about.`,
        `Save it as ${path.posix.join(dirRel, name)} (SVG, readable on both light and dark backgrounds).`,
        `Then link it in ${pageRel}: add visual=${name} to the end of this block's opening line:`,
        fence(b),
      ].join("\n");
    };

    const cellPlans = () => {
      const plans = {};
      for (const b of blocks) if (b.kind === "code") {
        const digest = crypto.createHash("sha256").update(b.src).digest("hex");
        if (cellImportance[digest]) plans[b.src] = cellImportance[digest];
      }
      return plans;
    };
    const sendAll = () => post({type: "render", blocks, files: files(), root, visuals: visuals(),
      name: path.basename(document.uri.fsPath), outputs: savedOut,
      colors: this.context.globalState.get(COLORS_KEY, {}), importance, cellImportance: cellPlans()});

    // Keep the .regain.md in step with the blocks, and saved.
    const commit = async () => {
      const text = serialize(blocks);
      if (text === document.getText()) return;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
      selfEdit++;
      await vscode.workspace.applyEdit(edit);
      await document.save();
    };

    const pyKey = "regain.python:" + document.uri.toString();
    const kernel = new Kernel(root, document.uri, ev => {
      if (ev.type === "status" && ev.python) ev.label = envLabel(ev.python);
      post({type: "kernel", ev});
    }, this.context.workspaceState.get(pyKey));
    const announcePython = async () => {
      const python = kernel.python || await pythonFor(document.uri);
      post({type: "kernel", ev: {type: "status", state: "off", python, label: envLabel(python)}});
    };

    // Like Jupyter's "Select Kernel": pick the Python the kernel runs on.
    const pickKernel = async () => {
      const current = kernel.python || await pythonFor(document.uri);
      const items = (await knownPythons()).map(p => ({
        label: (p.path === current ? "$(check) " : "") + envLabel(p.path) + (p.version ? ` (Python ${p.version})` : ""),
        description: p.path, path: p.path}));
      items.sort((a, b) => (b.path === current) - (a.path === current));
      items.push({label: "$(edit) Enter interpreter path…", path: null});
      const pick = await vscode.window.showQuickPick(items, {
        title: "Select kernel", placeHolder: "The Python needs jupyter_client and ipykernel", matchOnDescription: true});
      if (!pick) return;
      let python = pick.path;
      if (!python) {
        python = await vscode.window.showInputBox({prompt: "Path to a Python interpreter", value: current});
        if (!python) return;
      }
      await this.context.workspaceState.update(pyKey, python);
      kernel.setPython(python);
    };

    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, "**/*.{py,cpp,cc,cxx,h,hpp,hh,hxx,yaml,yml,json,toml,cfg,txt,sh,md,svg,png,jpg,jpeg,gif,webp}"));
    const onFile = uri => {
      if (samePath(uri.fsPath, bitesPath)) { bites = loadBites(); return sendAll(); }
      if (samePath(uri.fsPath, importancePath)) {
        importanceData = loadImportance();
        importance = importanceData.files || {};
        cellImportance = importanceData.cells || {};
        return sendAll();
      }
      if (blocks.some(b => (b.visual || []).some(v => samePath(path.resolve(pageDir, v), uri.fsPath)))) return sendAll();
      const b = blocks.find(x => x.kind === "file" && samePath(path.resolve(root, x.path), uri.fsPath));
      if (!b) return;
      if (selfWrites.get(b.path) === readText(uri.fsPath).text) { selfWrites.delete(b.path); return; }
      selfWrites.delete(b.path);
      sendAll();
    };
    watcher.onDidChange(onFile);
    watcher.onDidCreate(onFile);
    watcher.onDidDelete(onFile);

    const docSub = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.toString() !== document.uri.toString() || !e.contentChanges.length) return;
      if (selfEdit > 0) { selfEdit--; return; }
      blocks = parse(document.getText());
      sendAll();
    });

    let shellProcess = null;
    let shellRunId = 0;
    panel.onDidDispose(() => { watcher.dispose(); docSub.dispose(); kernel.dispose(); if (shellProcess) shellProcess.kill(); });

    panel.webview.onDidReceiveMessage(async m => {
      switch (m.type) {
        case "ready": sendAll(); announcePython(); break;
        case "pickKernel": await pickKernel(); break;

        case "setBlocks":             // edits, adds, deletes and moves from the view
          blocks = m.blocks;
          await commit();
          if (m.rerender) sendAll();
          break;

        case "writeFile": {           // a file block was run: save it
          const b = {path: m.path, range: m.range};
          const full = path.resolve(root, m.path);
          try {
            let text = m.text;
            const eol = fs.existsSync(full) ? readText(full).eol : "\n";
            if (b.range) {
              const lines = readText(full).text.split("\n");
              const n = m.text.split("\n").length;
              lines.splice(b.range[0] - 1, b.range[1] - b.range[0] + 1, ...m.text.split("\n"));
              text = lines.join("\n");
              const end = b.range[0] + n - 1;
              if (end !== b.range[1]) {   // keep the block's range covering the edited lines
                for (const x of blocks) if (x.kind === "file" && x.path === m.path && x.range &&
                    x.range[0] === b.range[0] && x.range[1] === b.range[1]) x.range = [b.range[0], end];
                await commit();
                post({type: "range", path: m.path, from: b.range, to: [b.range[0], end]});
              }
            }
            selfWrites.set(m.path, text);
            writeText(full, text, eol);
            await ws.update(seenKey(full), text);    // you wrote it, so you have seen it
            post({type: "saved", path: m.path, range: m.range, ok: true, lines: text.split("\n").length, content: fileInfo(b)});
            sendAll();
          } catch (e) {
            post({type: "saved", path: m.path, range: m.range, ok: false, error: e.message});
          }
          break;
        }

        case "addFile": {
          const rel = await vscode.window.showInputBox({
            prompt: `File path, relative to ${path.basename(root)}/`, placeHolder: "src/train.py"});
          if (!rel) return;
          const full = path.resolve(root, rel);
          if (!fs.existsSync(full)) {
            fs.mkdirSync(path.dirname(full), {recursive: true});
            fs.writeFileSync(full, "");
          }
          blocks.splice(m.at, 0, {kind: "file", path: rel, range: null});
          await commit();
          sendAll();
          break;
        }

        case "addVisual": {           // pick pictures from disk; they are copied next to the page
          const picked = await vscode.window.showOpenDialog({canSelectMany: true, openLabel: "Add",
            filters: {Images: ["svg", "png", "jpg", "jpeg", "gif", "webp"]}});
          const b = blocks[m.index];
          if (!picked || !b) return;
          fs.mkdirSync(path.join(pageDir, "visuals"), {recursive: true});
          for (const u of picked) {
            let name = "visuals/" + path.basename(u.fsPath);
            if (path.resolve(u.fsPath) !== path.resolve(pageDir, name)) {
              const ext = path.extname(name), stem = name.slice(0, -ext.length);
              for (let k = 2; fs.existsSync(path.resolve(pageDir, name)); k++) name = `${stem}-${k}${ext}`;
              fs.copyFileSync(u.fsPath, path.resolve(pageDir, name));
            }
            b.visual = [...(b.visual || []), name];
          }
          await commit();
          sendAll();
          break;
        }

        case "openVisual": {
          const uri = vscode.Uri.file(path.resolve(pageDir, m.path));
          if (m.external) await vscode.env.openExternal(uri);
          else await vscode.commands.executeCommand("vscode.open", uri,
            {viewColumn: panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One});
          break;
        }

        case "copyVisualRequest": {
          await vscode.env.clipboard.writeText(visualRequest(m.index));
          vscode.window.showInformationMessage("ReGain: request copied. Paste it to the agent in the side window.");
          break;
        }

        case "markSeen": {
          const full = path.resolve(root, m.path);
          if (fs.existsSync(full)) await ws.update(seenKey(full), readText(full).text);
          sendAll();
          break;
        }

        case "saveOutput":
          savedOut[m.src] = m.entry;
          writeOutputs();
          break;

        case "createMissing": {
          const full = path.resolve(root, m.path);
          fs.mkdirSync(path.dirname(full), {recursive: true});
          if (!fs.existsSync(full)) fs.writeFileSync(full, "");
          sendAll();
          break;
        }

        case "run":
          if (m.language === "shell") {
            if (shellProcess) { post({type: "runFailed", key: m.key}); break; }
            const id = `shell-${++shellRunId}`;
            const command = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
            const args = process.platform === "win32"
              ? ["-NoProfile", "-NonInteractive", "-Command", m.code]
              : ["-c", m.code];
            const child = spawn(command, args, {cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]});
            shellProcess = child;
            post({type: "runStarted", id, key: m.key});
            child.stdout.on("data", data => post({type: "kernel", ev: {type: "stream", id, name: "stdout", text: data.toString()}}));
            child.stderr.on("data", data => post({type: "kernel", ev: {type: "stream", id, name: "stderr", text: data.toString()}}));
            child.on("error", error => post({type: "kernel", ev: {type: "stream", id, name: "stderr", text: error.message + "\n"}}));
            child.on("close", code => {
              if (shellProcess === child) shellProcess = null;
              post({type: "kernel", ev: {type: "stream", id, name: code === 0 ? "stdout" : "stderr", text: `Exit code: ${code}\n`}});
              post({type: "kernel", ev: {type: "done", id, status: code === 0 ? "ok" : "error"}});
            });
            break;
          }
          try {
            const id = await kernel.exec(m.code);
            post({type: "runStarted", id, key: m.key});
          } catch { post({type: "runFailed", key: m.key}); }
          break;
        case "interrupt":
          if (shellProcess) shellProcess.kill();
          kernel.interrupt();
          break;
        case "restart": kernel.restart(); break;

        case "open": {
          const uri = vscode.Uri.file(path.resolve(root, m.path));
          const line = Math.max(0, (m.line || 1) - 1);
          const other = panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
          await vscode.window.showTextDocument(uri, {viewColumn: other, selection: new vscode.Range(line, 0, line, 0)});
          break;
        }

        case "colors":
          await this.context.globalState.update(COLORS_KEY, m.colors);
          break;
      }
    });
  }

  html(webview, media) {
    const nonce = crypto.randomBytes(16).toString("base64");
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, "notebook.css"));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, "notebook.js"));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} https://fonts.googleapis.com 'unsafe-inline'`,
      "font-src https://fonts.gstatic.com",
      `img-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Rubik:wght@500;600&family=Assistant:wght@400;600&family=JetBrains+Mono:wght@400&display=swap">
<link rel="stylesheet" href="${css}"></head>
<body><div class="app" id="app"></div>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
  }
}

module.exports = {NotebookEditor, envLabel, samePath};
