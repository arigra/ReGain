// ReGain: show .regain/*.html as a live page. Clicking a file link in the
// page opens that file in the editor, at the line after "#L" if given.
const vscode = require("vscode");
const path = require("path");
const {NotebookEditor} = require("./notebook/provider");

// Runs inside the page: follows the VS Code theme and routes link clicks.
const BRIDGE = `<script>
(() => {
  const api = acquireVsCodeApi();
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

    panel.webview.onDidReceiveMessage(async ({href}) => {
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
}

module.exports = {activate};
