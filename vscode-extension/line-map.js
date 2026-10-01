const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const {promisify} = require("util");
const vscode = require("vscode");
const {pythonFor} = require("./notebook/kernel");

const execFile = promisify(cp.execFile);

async function buildLineMap(root) {
  const script = path.join(root, ".regain", "tooling", "build_general_importance.py");
  if (!fs.existsSync(script)) throw new Error("Line importance generator is missing");
  const python = await pythonFor(vscode.Uri.file(root));
  const {stdout} = await execFile(python, [script, "--root", root], {
    cwd: root,
    timeout: 120000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    env: {...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1"},
  });
  return stdout.trim();
}

module.exports = {buildLineMap};
