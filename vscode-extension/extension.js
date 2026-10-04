// ReGain: show .regain/*.html as a live page. Clicking a file link in the
// page opens that file in the editor, at the line after "#L" if given.
const vscode = require("vscode");
const path = require("path");
const {NotebookEditor} = require("./notebook/provider");
const fs = require("fs");
const {setupProject} = require("./project-setup");
const {run, recordRun, notesPrompt, mapPrompt, branchPrompt} = require("./agent-runner");
const {writeGuide} = require("./guide");
const {makeVisual} = require("./visual");
const {normalizeMap, showAnalyzing, mergePreviousMap, saveMap, saveBranch, findCapability} = require("./semantic-map");
const {buildIndex} = require("./project-index");
const {readAllFiles, savedNotes} = require("./file-notes");
const {sendMessage, decideSuggestion} = require("./overview-chat");
const {loadConversation, loadLearner, updateProgress} = require("./conversation");
const {pageState} = require("./page-state");
const {buildLineMap} = require("./line-map");
const activeProjects = new Set();
const activeCapabilities = new Set();
const activeBranches = new Set();
// Open overview pages per project, so the conversation can stream into all of them.
const pages = new Map();
const postToPages = (root, message) => { for (const panel of pages.get(root) || []) panel.webview.postMessage(message); };
const chatDeps = root => ({run, post: message => postToPages(root, message), report: () => {}});
const refreshPages = async root => postToPages(root, {type: "state", ...(await pageState(root))});

async function analyzeProject(root, resume = false) {
  if (activeProjects.has(root)) return vscode.window.showInformationMessage("ReGain is already learning this project.");
  activeProjects.add(root);
  let map, created = false;
  try {
    await vscode.window.withProgress({location: vscode.ProgressLocation.Notification,
      title: "ReGain: learning the project", cancellable: true}, async (progress, token) => {
      {
        try {
          const saved = JSON.parse(await fs.promises.readFile(path.join(root, ".regain", "semantic-map.json"), "utf8"));
          if (saved.generatedByReGain && Array.isArray(saved.capabilities) && saved.capabilities.length) map = saved;
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      if (!map) {
        // Read every file first, from the files themselves (docs are claims, not truth), then build the map from those notes.
        const index = await buildIndex(root);
        const projectName = path.basename(root);
        const reading = await readAllFiles(root, index, {run, token, prompt: batch => notesPrompt(batch, projectName),
          report: message => progress.report({message})});
        const request = await mapPrompt(root, index, reading.notes);
        const raw = await run(root, "map", request, token, message => progress.report({message}));
        map = await normalizeMap(root, raw);
        map.reading = {read: reading.read, total: reading.total, unread: reading.failed, method: "all"};
        await mergePreviousMap(root, map);
        created = true;
      }
      map.analysis = {status: "complete", message: "Initial map ready. Explore children and create notebooks when you choose."};
      await saveMap(root, map);
    });
    if (map.analysis.status === "needs_review") vscode.window.showWarningMessage(`ReGain built a partial tree. ${map.analysis.message}. See the overview for details.`);
    else vscode.window.showInformationMessage("ReGain map ready. The guide below the map is introducing the subjects.");
    // A new map opens the conversation: the agent explains the project and offers its subjects.
    if (created && !(await loadConversation(root)).length) await sendMessage(root, {}, chatDeps(root));
  } catch (error) {
    const overviewFile = path.join(root, ".regain", "overview.html");
    const previous = await fs.promises.readFile(overviewFile, "utf8").catch(() => "");
    if (map) {
      map.analysis = {status: "stopped", message: error.message, unplaced: map.analysis?.unplaced || []};
      await saveMap(root, map).catch(() => {});
    } else if (!previous.includes("REGAIN_SEMANTIC_V1")) await showAnalyzing(root, error.message);
    vscode.window.showErrorMessage(`ReGain project analysis stopped: ${error.message}`);
  } finally {
    activeProjects.delete(root);
  }
}

async function analyzeCapability(root, id) {
  const key = `${root}:${id}`;
  if (activeCapabilities.has(key)) return vscode.window.showInformationMessage("ReGain is already analyzing this capability.");
  activeCapabilities.add(key);
  try {
    const map = JSON.parse(await fs.promises.readFile(path.join(root, ".regain", "semantic-map.json"), "utf8"));
    if (!map.generatedByReGain) throw new Error("The capability map is not a ReGain analysis");
    // The page covers this subject only; parts that have their own pages are named, not absorbed.
    const capability = findCapability(map, id);
    if (!capability) throw new Error("Capability was not found in the current map");
    const learner = await loadLearner(root);
    const context = {notes: await savedNotes(root), index: await buildIndex(root)};
    const started = Date.now();
    const result = await vscode.window.withProgress({location: vscode.ProgressLocation.Notification,
      title: `ReGain: writing the guide for ${capability.name}`, cancellable: true}, async (progress, token) => {
      // Three calls at most: write, review, and fix only if hard rules still fail.
      const call = (kind, request, title) => run(root, kind, request, token, message => progress.report({message}), title);
      const saved = await writeGuide(root, map, capability, {call, learner, context});
      try { await buildLineMap(root); }
      catch (error) { saved.lineMapWarning = error.message; }
      return saved;
    });
    // The whole guide's time, so the overview can say how long a guide usually takes.
    await recordRun(root, {kind: "guide", title: `Guide for ${capability.name}`, ms: Date.now() - started, ok: true});
    await vscode.commands.executeCommand("vscode.openWith", vscode.Uri.file(result.notebookPath), "regain.notebook", vscode.ViewColumn.Two);
    await updateProgress(root, {started: id});
    await refreshPages(root);
    vscode.window.showInformationMessage(`ReGain wrote and reviewed a ${result.sections}-section guide for ${capability.name}.`);
    if (result.remaining.length || result.problems.length)
      vscode.window.showWarningMessage(`ReGain's guide for ${capability.name} still has ${result.remaining.length} unfixed problems${result.problems.length ? ` (${result.problems.join(" ")})` : ""}. Details are in ${path.basename(result.recordPath)}.`);
    if (result.lineMapWarning) vscode.window.showWarningMessage(`ReGain could not create line colors: ${result.lineMapWarning}`);
  } catch (error) {
    vscode.window.showErrorMessage(`ReGain capability analysis stopped: ${error.message}`);
  } finally {
    activeCapabilities.delete(key);
  }
}

async function expandCapability(root, id) {
  const key = `${root}:${id}`;
  if (activeBranches.has(key)) return vscode.window.showInformationMessage("ReGain is already exploring this branch.");
  activeBranches.add(key);
  try {
    const map = JSON.parse(await fs.promises.readFile(path.join(root, ".regain", "semantic-map.json"), "utf8"));
    if (!map.generatedByReGain) throw new Error("The capability map is not a ReGain analysis");
    const selected = findCapability(map, id);
    if (!selected) throw new Error("Capability was not found in the current map");
    if (selected.refined) return;
    const result = await vscode.window.withProgress({location: vscode.ProgressLocation.Notification,
      title: `ReGain: exploring ${selected.name}`, cancellable: true}, async (progress, token) => {
      const raw = await run(root, "branch", await branchPrompt(root, map, selected), token, message => progress.report({message}), `Splitting ${selected.name}`);
      return saveBranch(root, id, raw);
    });
    vscode.window.showInformationMessage(result.children.length
      ? `ReGain found ${result.children.length} parts under ${selected.name}.`
      : `ReGain found no useful smaller split under ${selected.name}.`);
  } catch (error) {
    vscode.window.showErrorMessage(`ReGain could not explore this branch: ${error.message}`);
  } finally {
    activeBranches.delete(key);
  }
}

// "Draw a visual" beside a notebook block. onStep shows the agent's latest step in the block's panel.
async function drawVisual(root, request, onStep) {
  return vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: `ReGain: drawing a visual for ${request.label}`, cancellable: true},
    (progress, token) => makeVisual(root, request, (kind, prompt, title) => {
      if (typeof onStep === "function") prompt.onStep = onStep;
      return run(root, kind, prompt, token, message => progress.report({message}), title);
    }));
}

// Runs inside the page: follows the VS Code theme and routes link clicks.
const BRIDGE = `<script>
(() => {
  const api = acquireVsCodeApi();
  window.regainApi = api;
  const theme = () => {
    const light = document.body.classList.contains("vscode-light");
    document.documentElement.dataset.theme = light ? "light" : "dark";
  };
  theme();
  new MutationObserver(theme).observe(document.body, {attributes: true, attributeFilter: ["class"]});
  document.addEventListener("click", e => {
    const a = e.target.closest("a[href]");
    if (!a) return;
    e.preventDefault();
    api.postMessage({href: a.getAttribute("href")});
  }, true);
})();
</script>`;

class PageEditor {
  openCustomDocument(uri) {
    return {uri, dispose() {}};
  }

  resolveCustomEditor(doc, panel) {
    const dir = path.dirname(doc.uri.fsPath);
    panel.webview.options = {enableScripts: true};

    const render = async () => {
      const bytes = await vscode.workspace.fs.readFile(doc.uri);
      let html = Buffer.from(bytes).toString("utf8");
      if (html.includes("REGAIN_SEMANTIC_V1")) {
        try {
          const map = JSON.parse(await fs.promises.readFile(path.join(dir, "semantic-map.json"), "utf8"));
          const root = path.dirname(dir);
          if (map.generatedByReGain) html = require("./semantic-tree-diagram").semanticDiagram(map, await pageState(root));
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      panel.webview.html = html.includes("</body>")
        ? html.replace("</body>", BRIDGE + "</body>")
        : html + BRIDGE;
    };
    render();

    // Re-render when the page is regenerated on disk.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(dir, path.basename(doc.uri.fsPath)));
    watcher.onDidChange(render);
    const projectRoot = path.dirname(dir);
    if (!pages.has(projectRoot)) pages.set(projectRoot, new Set());
    pages.get(projectRoot).add(panel);
    panel.onDidDispose(() => { watcher.dispose(); pages.get(projectRoot)?.delete(panel); });

    panel.webview.onDidReceiveMessage(async message => {
      if (message.type === "retryAnalysis") {
        if (!panel.webview.html.includes("REGAIN_SEMANTIC_V1")) await showAnalyzing(path.dirname(dir));
        await analyzeProject(path.dirname(dir), true);
        return;
      }
      if (message.type === "analyzeCapability") {
        await analyzeCapability(path.dirname(dir), String(message.id || ""));
        return;
      }
      if (message.type === "chat") {
        await sendMessage(path.dirname(dir), {text: String(message.text || ""), selectedId: message.selectedId || ""}, chatDeps(path.dirname(dir)));
        return;
      }
      if (message.type === "chatStart") {
        if (!(await loadConversation(path.dirname(dir))).length) await sendMessage(path.dirname(dir), {}, chatDeps(path.dirname(dir)));
        return;
      }
      if (message.type === "markCovered") {
        await updateProgress(path.dirname(dir), {id: String(message.id || ""), covered: !!message.covered});
        await refreshPages(path.dirname(dir));
        return;
      }
      if (message.type === "openGuide") {
        const guide = path.join(dir, `capability-${String(message.id || "").replace(/[^\w.-]/g, "")}.regain.md`);
        if (fs.existsSync(guide)) await vscode.commands.executeCommand("vscode.openWith", vscode.Uri.file(guide), "regain.notebook", vscode.ViewColumn.Two);
        return;
      }
      if (message.type === "decideSuggestion") {
        await decideSuggestion(path.dirname(dir), {message: Number(message.message), index: Number(message.index), apply: !!message.apply}, chatDeps(path.dirname(dir)));
        return;
      }
      if (message.type === "expandCapability") {
        await expandCapability(path.dirname(dir), String(message.id || ""));
        return;
      }
      if (message.type === "prepareScope") {
        try {
          const root = path.dirname(dir);
          const selected = String(message.path || "");
          if (selected.startsWith("/") || selected.includes("\\") || selected.split("/").includes("..")) throw new Error("Invalid branch path");
          const target = path.resolve(root, selected);
          if (target !== root && !target.startsWith(root + path.sep)) throw new Error("Branch is outside this project");
          const realRoot = await fs.promises.realpath(root);
          const realTarget = await fs.promises.realpath(target);
          if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) throw new Error("Branch resolves outside this project");
          const symbol = String(message.symbol || "");
          if (symbol && !/^[A-Za-z_][A-Za-z_0-9]*$/.test(symbol)) throw new Error("Invalid function name");
          const scope = {path: selected, symbol, line: Number(message.line || 0), end: Number(message.end || 0)};
          if (symbol && (!(scope.line > 0) || scope.end < scope.line)) throw new Error("Invalid function lines");
          const {generate} = require("./project-generator");
          const {buildLineMap} = require("./line-map");
          const result = await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: `ReGain: preparing ${symbol || selected || path.basename(root)}`, cancellable: false},
            async () => {
              const created = await generate(root, symbol || selected || path.basename(root), scope);
              try { await buildLineMap(root); }
              catch (error) { created.lineMapWarning = error.message; }
              return created;
            });
          await vscode.commands.executeCommand("vscode.openWith", vscode.Uri.file(result.notebookPath), "regain.notebook", vscode.ViewColumn.Two);
          vscode.window.showInformationMessage(`ReGain created a walkthrough for ${symbol || selected || path.basename(root)} (${result.selected.length} source files).`);
          if (result.lineMapWarning) vscode.window.showWarningMessage(`ReGain could not create line colors: ${result.lineMapWarning}`);
        } catch (error) {
          vscode.window.showErrorMessage(`ReGain could not prepare this branch: ${error.message}`);
        }
        return;
      }
      const {href} = message;
      if (typeof href !== "string") return;
      if (/^https?:/.test(href)) return vscode.env.openExternal(vscode.Uri.parse(href));
      const m = href.replace(/^vscode:\/\/file/, "").match(/^([^#]*?)(?::(\d+))?(?:#L(\d+))?$/);
      if (!m) return;
      const target = path.resolve(dir, decodeURIComponent(m[1]));
      const line = Math.max(0, Number(m[2] || m[3] || 1) - 1);
      const uri = vscode.Uri.file(target);
      const stat = await vscode.workspace.fs.stat(uri).then(s => s, () => null);
      if (!stat) return vscode.window.showWarningMessage(`ReGain: ${target} not found`);
      if (stat.type & vscode.FileType.Directory) {
        return vscode.commands.executeCommand("revealInExplorer", uri);
      }
      const other = panel.viewColumn === vscode.ViewColumn.One
        ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
      const range = new vscode.Range(line, 0, line, 0);
      await vscode.window.showTextDocument(uri, {viewColumn: other, selection: range});
    });
  }
}

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand("regain.drawVisual", (root, request, onStep) => drawVisual(root, request, onStep)));
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(
    "regain.page", new PageEditor(),
    {webviewOptions: {retainContextWhenHidden: true}}));
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(
    "regain.notebook", new NotebookEditor(context),
    {webviewOptions: {retainContextWhenHidden: true}}));


  context.subscriptions.push(vscode.window.registerTreeDataProvider("regain.start", {
    getTreeItem: item => item,
    getChildren: () => [],
  }));

  const initialize = async (root, openFolder, empty = false) => {
    try {
      const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "ReGain: mapping project tree",
        cancellable: false,
      }, () => setupProject(root, context.extensionPath, "", empty));
      if (openFolder) {
        await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(root), {forceNewWindow: true});
      } else {
        await vscode.commands.executeCommand("vscode.openWith", vscode.Uri.file(result.overviewPath), "regain.page");
      }
      if (empty) {
        vscode.window.showInformationMessage("The empty folder is open. Add your project files, then choose Prepare Current Project in ReGain.");
      } else {
        await analyzeProject(root);
      }
    } catch (error) {
      vscode.window.showErrorMessage(`ReGain setup failed: ${error.message}`);
    }
  };

  context.subscriptions.push(vscode.commands.registerCommand("regain.initCurrent", async () => {
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.length) return vscode.window.showWarningMessage("Open a project folder first, or choose a folder from ReGain.");
    let folder = folders[0];
    if (folders.length > 1) {
      const picked = await vscode.window.showQuickPick(folders.map(item => ({label: item.name, folder: item})));
      if (!picked) return;
      folder = picked.folder;
    }
    await initialize(folder.uri.fsPath, false);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("regain.initFolder", async () => {
    const selected = await vscode.window.showOpenDialog({canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Set up with ReGain"});
    if (selected?.length) await initialize(selected[0].fsPath, true);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("regain.createFolder", async () => {
    const selected = await vscode.window.showOpenDialog({canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Choose parent folder"});
    if (!selected?.length) return;
    const name = await vscode.window.showInputBox({prompt: "Name for the new project folder", validateInput: value =>
      !value || value === "." || value === ".." || /[\\/<>:"|?*]/.test(value) ? "Enter one valid folder name" : null});
    if (!name) return;
    const root = path.join(selected[0].fsPath, name);
    if (fs.existsSync(root)) return vscode.window.showWarningMessage(`Folder already exists: ${root}`);
    try { await fs.promises.mkdir(root); }
    catch (error) { return vscode.window.showErrorMessage(`Could not create folder: ${error.message}`); }
    await initialize(root, true, true);
  }));
}

module.exports = {activate};
