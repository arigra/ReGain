const fs = require("fs");
const path = require("path");
const {diagramPage} = require("./project-diagram");

const SKIP = new Set([".git", ".regain", ".venv", "venv", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", "dist", "build", "outputs", "tmp"]);
const CODE = new Set([".py", ".js", ".ts", ".tsx", ".cpp", ".cc", ".c", ".h", ".hpp", ".rs", ".go", ".java"]);
const esc = value => String(value).replace(/[&<>"']/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[char]));
const posix = value => value.split(path.sep).join("/");

function functionsIn(source) {
  const lines = source.split(/\r?\n/);
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(\s*)(?:async\s+)?(?:def|class|function)\s+([A-Za-z_][\w]*)\b/);
    if (!match || match[1].length > 4) continue;
    found.push({name: match[2], line: i + 1, indent: match[1].length});
    if (found.length >= 60) break;
  }
  for (let i = 0; i < found.length; i++) {
    const start = found[i];
    const next = found.slice(i + 1).find(item => item.indent <= start.indent);
    start.end = next ? next.line - 1 : lines.length;
    delete start.indent;
  }
  return found;
}

async function scan(root) {
  const tree = {name: path.basename(root), path: "", kind: "directory", children: []};
  const queue = [{node: tree, full: root, depth: 0}];
  let count = 0;
  let truncated = false;
  while (queue.length) {
    const {node, full, depth} = queue.shift();
    let entries;
    try { entries = await fs.promises.readdir(full, {withFileTypes: true}); }
    catch { continue; }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++count > 12000) { truncated = true; break; }
      const relative = posix(path.relative(root, path.join(full, entry.name)));
      if (entry.isDirectory()) {
        if (depth >= 12 || SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
        const child = {name: entry.name, path: relative, kind: "directory", children: []};
        node.children.push(child);
        queue.push({node: child, full: path.join(full, entry.name), depth: depth + 1});
      } else if (entry.isFile() && CODE.has(path.extname(entry.name).toLowerCase())) {
        const child = {name: entry.name, path: relative, kind: "file", children: []};
        node.children.push(child);
        if (fs.statSync(path.join(full, entry.name)).size < 120000) {
          try {
            const source = await fs.promises.readFile(path.join(full, entry.name), "utf8");
            child.children = functionsIn(source).map(item => ({...item, kind: "function", path: relative}));
          } catch { /* unreadable source still appears as a file */ }
        }
      }
    }
    if (truncated) break;
  }
  function prune(node) {
    if (node.kind !== "directory") return true;
    node.children = node.children.filter(prune);
    return node.path === "" || node.children.length > 0;
  }
  prune(tree);
  return {tree, truncated};
}

function renderNode(node, depth = 0) {
  const attrs = `data-path="${esc(node.path)}"` + (node.kind === "function" ? ` data-line="${node.line}" data-end="${node.end}" data-symbol="${esc(node.name)}"` : "");
  const icon = node.kind === "directory" ? "▣" : node.kind === "file" ? "◇" : "ƒ";
  const label = `<button class="select" ${attrs} title="Create a walkthrough for ${esc(node.name)}"><span class="icon">${icon}</span>${esc(node.name)}</button>`;
  if (!node.children?.length) return `<li class="leaf">${label}</li>`;
  const children = node.children.map(child => renderNode(child, depth + 1)).join("");
  return `<li class="branch"><div class="row"><button class="toggle" aria-label="Expand ${esc(node.name)}" aria-expanded="${depth < 1}" title="Expand or collapse">${depth < 1 ? "▾" : "▸"}</button>${label}<span class="count">${node.children.length}</span></div><ul${depth < 1 ? "" : ' hidden="hidden"'}>${children}</ul></li>`;
}

function treePage(root, tree, truncated) {
  return `<!doctype html><!-- REGAIN_TREE_V1 -->
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(path.basename(root))} · ReGain</title>
<style>
:root{font-family:Inter,Segoe UI,system-ui,sans-serif;color-scheme:dark;background:#101923;color:#edf4f7;--panel:#1b2a38;--border:#355064;--muted:#a8bfce;--accent:#79dce2}
:root[data-theme="light"]{color-scheme:light;background:#f4f8fa;color:#172a36;--panel:#fff;--border:#ccdae2;--muted:#506675;--accent:#087c87}
*{box-sizing:border-box}body{margin:0;padding:clamp(20px,4vw,45px)}main{max-width:1080px;margin:auto}.eyebrow{color:var(--accent);font-size:.76rem;font-weight:750;letter-spacing:.15em;text-transform:uppercase}h1{font-size:clamp(2rem,4vw,3.2rem);margin:12px 0}p{color:var(--muted);line-height:1.55;max-width:760px}.tree{background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:12px 10px 18px;box-shadow:0 18px 45px #0002;margin-top:27px}ul{list-style:none;margin:0;padding-left:22px}ul ul{border-left:1px solid var(--border);margin-left:12px}.row,.leaf{display:flex;align-items:center;min-height:37px}.toggle,.select{background:transparent;border:0;color:inherit;font:inherit;cursor:pointer}.toggle{width:25px;height:27px;color:var(--accent);flex:none}.select{text-align:left;padding:6px 8px;border-radius:7px}.select:hover,.select:focus-visible{background:color-mix(in srgb,var(--accent) 15%,transparent);outline:none}.icon{display:inline-block;width:23px;color:var(--accent)}.count{color:var(--muted);font-size:.78rem;margin-left:5px}#status{min-height:25px;color:var(--accent);font-size:.9rem}footer{font-size:.82rem;margin-top:20px}
</style></head><body><main><div class="eyebrow">ReGain · choose a scope</div><h1>${esc(path.basename(root))}</h1><p>Explore folders, files, and functions. Click a name to create a source walkthrough for that exact branch. Click its arrow to expand the tree. A folder includes all source files beneath it.</p><div id="status" role="status"></div><div class="tree"><ul>${renderNode(tree)}</ul></div><footer><p>${truncated ? "The tree reached its discovery limit; narrow the workspace if a branch is missing." : "ReGain reads the local source tree. It does not execute project code."}</p></footer></main>
<script>window.addEventListener("DOMContentLoaded",()=>{document.querySelectorAll(".toggle").forEach(button=>button.addEventListener("click",()=>{const list=button.closest("li").querySelector(":scope > ul");const open=list.hidden;list.hidden=!open;button.textContent=open?"▾":"▸";button.setAttribute("aria-expanded",String(open));}));document.querySelectorAll(".select").forEach(button=>button.addEventListener("click",()=>{document.getElementById("status").textContent="Preparing " + button.textContent.trim() + "…";window.regainApi.postMessage({type:"prepareScope",path:button.dataset.path,symbol:button.dataset.symbol||"",line:Number(button.dataset.line||0),end:Number(button.dataset.end||0)});}));});</script></body></html>`;
}

async function prepareTree(root) {
  const {tree, truncated} = await scan(root);
  const dir = path.join(root, ".regain");
  await fs.promises.mkdir(dir, {recursive: true});
  let overviewPath = path.join(dir, "overview.html");
  try {
    const previous = await fs.promises.readFile(overviewPath, "utf8");
    if (!previous.includes("REGAIN_TREE_V1") && !previous.includes("REGAIN_GENERATED_V1")) overviewPath = path.join(dir, "repo-tree.html");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await fs.promises.writeFile(overviewPath, diagramPage(root, tree, truncated), "utf8");
  return {overviewPath, updated: true};
}

module.exports = {prepareTree};
