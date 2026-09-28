// Custom editor for *.regain.md: headings, file blocks and code blocks.
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const {parse, serialize} = require("./format");
const {Kernel, pythonFor} = require("./kernel");

const COLORS_KEY = "regain.colors";

// A .regain.md inside .regain/ belongs to the project one level up.
function projectRoot(uri) {
  const dir = path.dirname(uri.fsPath);
  if (path.basename(dir) === ".regain") return path.dirname(dir);
  const ws = vscode.workspace.getWorkspaceFolder(uri);
  return ws ? ws.uri.fsPath : dir;
}

// A short name for an interpreter: the conda env, the venv, or its folder.
function envLabel(python) {
  const parts = python.split(path.sep);
  const envs = parts.lastIndexOf("envs");
  if (envs >= 0 && parts[envs + 1]) return parts[envs + 1];
  const bin = parts.lastIndexOf("bin");
  return bin > 0 ? parts[bin - 1] : python;
}

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
  const text = fs.readFileSync(full, "utf8");
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
    panel.webview.options = {enableScripts: true, localResourceRoots: [media]};
    panel.webview.html = this.html(panel.webview, media);

    let blocks = parse(document.getText());
    let selfEdit = 0;                 // document changes we made ourselves
    const selfWrites = new Map();     // file path -> text we just wrote
    const post = msg => panel.webview.postMessage(msg);

    const files = () => {
      const out = {};
      for (const b of blocks) if (b.kind === "file" && b.path) out[b.path] = readFileBlock(root, b);
      return out;
    };
    const sendAll = () => post({type: "render", blocks, files: files(), root,
      name: path.basename(document.uri.fsPath),
      colors: this.context.globalState.get(COLORS_KEY, {})});

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

    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, "**/*.{py,yaml,yml,json,toml,cfg,txt,sh,md}"));
    const onFile = uri => {
      const b = blocks.find(x => x.kind === "file" && path.resolve(root, x.path) === uri.fsPath);
      if (!b) return;
      const content = readFileBlock(root, b);
      if (selfWrites.get(b.path) === content.text) return;   // our own write echoing back
      selfWrites.delete(b.path);
      post({type: "file", path: b.path, content});
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

    panel.onDidDispose(() => { watcher.dispose(); docSub.dispose(); kernel.dispose(); });

    panel.webview.onDidReceiveMessage(async m => {
      switch (m.type) {
        case "ready": sendAll(); announcePython(); break;
        case "pickKernel": await pickKernel(); break;

        case "setBlocks":             // edits, adds, deletes and moves from the view
          blocks = m.blocks;
          await commit();
          if (m.rerender) sendAll();
          break;

        case "writeFile": {           // typing inside a file block
          const b = {path: m.path, range: m.range};
          const full = path.resolve(root, m.path);
          let text = m.text;
          if (b.range) {
            const lines = fs.readFileSync(full, "utf8").split("\n");
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
          selfWrites.set(m.path, m.text);
          fs.writeFileSync(full, text);
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

        case "createMissing": {
          const full = path.resolve(root, m.path);
          fs.mkdirSync(path.dirname(full), {recursive: true});
          if (!fs.existsSync(full)) fs.writeFileSync(full, "");
          sendAll();
          break;
        }

        case "run":
          try {
            const id = await kernel.exec(m.code);
            post({type: "runStarted", id, key: m.key});
          } catch { post({type: "runFailed", key: m.key}); }
          break;
        case "interrupt": kernel.interrupt(); break;
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

module.exports = {NotebookEditor};
