const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const destination = path.join(root, "vscode-extension", "resources", "tooling");
fs.mkdirSync(destination, {recursive: true});
for (const file of ["build_general_importance.py", "cpp_importance.py"]) {
  fs.copyFileSync(path.join(root, "tools", file), path.join(destination, file));
}
