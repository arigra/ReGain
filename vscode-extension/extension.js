// ReGain: show .regain/*.html as a live page. Clicking a file link in the
// page opens that file in the editor, at the line after "#L" if given.
const vscode = require("vscode");
const path = require("path");
const {NotebookEditor} = require("./notebook/provider");
const fs = require("fs");
const {setupProject} = require("./project-setup");
const {run, mapPrompt, branchPrompt, auditPrompt, detailPrompt} = require("./agent-runner");
const {normalizeMap, normalizeBranch, showAnalyzing, mergePreviousMap, saveMap, saveBranch, findCapability, scopedCapability, saveDetail} = require("./semantic-map");
const {buildLineMap} = require("./line-map");
const {inventory, resumeCoverage, coveragePrompt, applyDecisions, completeCoverage, saveCoverage} = require("./file-coverage");
const activeProjects = new Set();
const activeCapabilities = new Set();
const activeBranches = new Set();

function featurePlaced(missing, children) {
  const words = value => new Set(String(value || "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").split(" ")
    .filter(word => word.length > 2 && !["and", "the", "for", "with", "specific", "driver"].includes(word)));
  const sought = words(missing.name);
  const evidence = new Set(missing.evidencePaths || []);
  return children.some(child => {
    const label = words(child.name);
    const shared = [...sought].filter(word => label.has(word)).length;
    const sourceMatch = (child.sources || []).some(source => evidence.has(source.path));
    return child.name.toLowerCase().includes(missing.name.toLowerCase())
      || (sourceMatch && shared >= Math.min(2, sought.size));
  });
}

async function analyzeProject(root, resume = false) {
  if (activeProjects.has(root)) return vscode.window.showInformationMessage("ReGain is already learning this project.");
  activeProjects.add(root);
  let map;
  try {
    await vscode.window.withProgress({location: vscode.ProgressLocation.Notification,
      title: "ReGain: learning the project", cancellable: true}, async (progress, token) => {
      if (resume) {
        try {
          const saved = JSON.parse(await fs.promises.readFile(path.join(root, ".regain", "semantic-map.json"), "utf8"));
          if (saved.generatedByReGain && saved.analysis?.status !== "complete") map = saved;
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      if (!map) {
        const raw = await run(root, "map", mapPrompt(), token, message => progress.report({message}));
        map = await normalizeMap(root, raw);
        await mergePreviousMap(root, map);
      }
      const savedCoverageExists = resume && fs.existsSync(path.join(root, ".regain", "file-coverage.json"));
      const unplaced = [...(map.analysis?.unplaced || [])];
      map.analysis = {status: "in_progress", message: "Discovering project features", unplaced};
      await saveMap(root, map);
      for (let index = 0; index < map.capabilities.length; index++) {
        const capability = map.capabilities[index];
        if (capability.refined) continue;
        const label = `Discovering features ${index + 1}/${map.capabilities.length}: ${capability.name}`;
        progress.report({message: label});
        const branch = await run(root, "branch", branchPrompt(capability), token,
          message => progress.report({message: `${label} — ${message}`}));
        capability.children = await normalizeBranch(root, capability, branch);
        capability.refined = true;
        capability.refinementNotes = (branch.uncertainties || []).filter(Boolean).slice(0, 20);
        map.analysis.message = `Discovered ${index + 1}/${map.capabilities.length} capability branches`;
        await saveMap(root, map);
      }
      if (!savedCoverageExists) {
      progress.report({message: "Checking the tree for missing named features"});
      const audit = await run(root, "audit", auditPrompt(map), token,
        message => progress.report({message: `Checking feature coverage — ${message}`}));
      if (!Array.isArray(audit.missing)) throw new Error("Feature coverage audit returned no result");
      const omissionsByParent = new Map();
      for (const missing of audit.missing) {
        if (!omissionsByParent.has(missing.parentId)) omissionsByParent.set(missing.parentId, []);
        omissionsByParent.get(missing.parentId).push(missing);
      }
      for (const [parentId, omissions] of omissionsByParent) {
        const parent = map.capabilities.find(item => item.id === parentId);
        if (!parent) {
          unplaced.push(...omissions);
          continue;
        }
        progress.report({message: `Tracing omitted features under ${parent.name}`});
        const hints = omissions.map(item => `${item.name}: ${(item.evidencePaths || []).join(", ")}`).join("; ");
        const prompt = `${branchPrompt(parent)}\nA coverage audit found potentially omitted features: ${hints}. Verify each in source and include real ones as named children. Preserve the other verified child features.`;
        const branch = await run(root, "branch", prompt, token, message => progress.report({message}));
        const children = await normalizeBranch(root, parent, branch);
        const existing = new Set(parent.children.map(child => child.id));
        parent.children.push(...children.filter(child => !existing.has(child.id)));
        for (const missing of omissions) {
          if (featurePlaced(missing, parent.children)) continue;
          progress.report({message: `Verifying audited feature: ${missing.name}`});
          const focused = await run(root, "branch", `${branchPrompt(parent)}\nThe audit identified "${missing.name}" in ${(missing.evidencePaths || []).join(", ")}. Verify it in source. If real and distinct, return exactly one child named "${missing.name}" with its feature-specific sources and flow. If already covered or unsupported, return no children and explain in uncertainties.`, token,
            message => progress.report({message}));
          const specific = await normalizeBranch(root, parent, focused);
          parent.children.push(...specific.filter(child => !parent.children.some(current => current.id === child.id)));
          if (!featurePlaced(missing, parent.children)) unplaced.push(missing);
        }
        map.analysis.message = `Audited features under ${parent.name}`;
        await saveMap(root, map);
      }
      if (unplaced.length) {
        map.analysis.unplaced = unplaced;
        map.uncertainties.push(...unplaced.map(item => `Audit could not confirm placement of ${item.name}: ${(item.evidencePaths || []).join(", ")}`));
      }
      map.analysis.message = "Checking repository file coverage";
      await saveMap(root, map);
      }
      progress.report({message: "Inventorying repository files"});
      const coverage = await inventory(root, map);
      if (resume) await resumeCoverage(root, coverage);
      await saveCoverage(root, coverage);
      const pending = coverage.files.filter(file => file.status === "unresolved").map(file => file.path);
      for (let offset = 0; offset < pending.length; offset += 60) {
        const paths = pending.slice(offset, offset + 60);
        progress.report({message: `Classifying files ${offset + 1}-${offset + paths.length} of ${pending.length}`});
        const decisions = await run(root, "coverage", coveragePrompt(map, paths), token,
          message => progress.report({message: `Classifying files ${offset + 1}-${offset + paths.length}: ${message}`}));
        applyDecisions(coverage, decisions, paths, map);
        await saveCoverage(root, coverage);
      }
      const retry = coverage.files.filter(file => file.retry).map(file => file.path);
      for (let offset = 0; offset < retry.length; offset += 10) {
        const paths = retry.slice(offset, offset + 10);
        progress.report({message: `Clarifying ${offset + 1}-${offset + paths.length} of ${retry.length} incomplete file decisions`});
        const decisions = await run(root, "coverage", coveragePrompt(map, paths) + "\nThe previous answer omitted or failed to explain these files. Give a concrete reason for each classification. If evidence is insufficient, use unresolved and explain what is missing.", token,
          message => progress.report({message}));
        applyDecisions(coverage, decisions, paths, map);
        await saveCoverage(root, coverage);
      }
      const newFeatures = coverage.files.filter(file => file.status === "new_feature");
      const featuresByParent = new Map();
      for (const file of newFeatures) {
        const parentId = file.capabilityIds[0];
        if (!featuresByParent.has(parentId)) featuresByParent.set(parentId, []);
        featuresByParent.get(parentId).push(file);
      }
      for (const [parentId, files] of featuresByParent) {
        const parent = map.capabilities.find(item => item.id === parentId);
        if (!parent) throw new Error(`File coverage found a feature without a parent: ${files[0].path}`);
        progress.report({message: `Adding features found in files under ${parent.name}`});
        const hints = files.map(file => `${file.featureName}: ${file.path}`).join("; ");
        const branch = await run(root, "branch", `${branchPrompt(parent)}\nFile coverage found potentially omitted features: ${hints}. Verify each and name real features as children. Preserve the other verified child features.`, token,
          message => progress.report({message}));
        const children = await normalizeBranch(root, parent, branch);
        const existing = new Set(parent.children.map(child => child.id));
        parent.children.push(...children.filter(child => !existing.has(child.id)));
        for (const file of files) {
          if (!featurePlaced({name: file.featureName, evidencePaths: [file.path]}, parent.children))
            unplaced.push({name: file.featureName, parentId, evidencePaths: [file.path]});
        }
        map.analysis.message = `Added file-discovered features under ${parent.name}`;
        await saveMap(root, map);
      }
      map.coverage = completeCoverage(coverage, map);
      await saveCoverage(root, coverage);
      const remaining = coverage.counts.unresolved + coverage.counts.new_feature;
      map.analysis = unplaced.length || remaining
        ? {status: "needs_review", message: `${unplaced.length} features and ${remaining} files need review`, unplaced}
        : {status: "complete", message: "Capability and file coverage complete"};
      await saveMap(root, map);
    });
    if (map.analysis.status === "needs_review") vscode.window.showWarningMessage(`ReGain built a partial tree. ${map.analysis.message}. See the overview for details.`);
    else vscode.window.showInformationMessage("ReGain finished discovering the project's capabilities. Select a feature for detailed analysis.");
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
    const selected = findCapability(map, id);
    const capability = selected && scopedCapability(selected);
    if (!capability) throw new Error("Capability was not found in the current map");
    const result = await vscode.window.withProgress({location: vscode.ProgressLocation.Notification,
      title: `ReGain: tracing ${capability.name}`, cancellable: true}, async (progress, token) => {
      const raw = await run(root, "detail", detailPrompt(capability), token, message => progress.report({message}));
      const saved = await saveDetail(root, capability, raw);
      try { await buildLineMap(root); }
      catch (error) { saved.lineMapWarning = error.message; }
      return saved;
    });
    await vscode.commands.executeCommand("vscode.openWith", vscode.Uri.file(result.notebookPath), "regain.notebook", vscode.ViewColumn.Two);
    vscode.window.showInformationMessage(`ReGain traced ${capability.name}: ${result.sourceBlocks} source blocks, ${result.reviewedLines} reviewed line reasons.`);
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
      const raw = await run(root, "branch", branchPrompt(selected), token, message => progress.report({message}));
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
      const html = Buffer.from(bytes).toString("utf8");
      panel.webview.html = html.includes("</body>")
        ? html.replace("</body>", BRIDGE + "</body>")
        : html + BRIDGE;
    };
    render();

    // Re-render when the page is regenerated on disk.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(dir, path.basename(doc.uri.fsPath)));
    watcher.onDidChange(render);
    panel.onDidDispose(() => watcher.dispose());

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
