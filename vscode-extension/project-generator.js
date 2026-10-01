// Local, bounded project discovery. No agent or network call is needed to make
// the first useful ReGain pages; deeper semantic review can happen later.
const fs = require("fs");
const path = require("path");

const SKIP = new Set([".git", ".regain", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", "dist", "build", "outputs", "tmp"]);
const CODE = new Set([".py", ".js", ".ts", ".tsx", ".cpp", ".cc", ".c", ".h", ".hpp", ".rs", ".go", ".java"]);
const STAGES = [
  ["config", "Settings and contracts", "Find the values and input types that shape a run."],
  ["input", "Input and entry", "See how the program receives and prepares data."],
  ["process", "Processing", "Follow the main transformations and state updates."],
  ["decision", "Decision", "Locate scoring, classification, or output gates."],
  ["check", "Check and evaluation", "Find how results are inspected or measured."],
];

function html(value) {
  return String(value).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
}
const posix = value => value.split(path.sep).join("/");
const normalize = value => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

async function discover(root, focus, scope = null) {
  const files = [];
  const selectedPath = scope ? path.resolve(root, scope.path) : root;
  const selectedStat = scope ? await fs.promises.stat(selectedPath) : null;
  if (selectedStat?.isFile()) files.push(posix(path.relative(root, selectedPath)));
  const queue = selectedStat?.isFile() ? [] : [{dir: selectedPath, depth: 0}];
  let visited = 0;
  while (queue.length && visited < 5000 && files.length < 2500) {
    const {dir, depth} = queue.shift();
    let entries;
    try { entries = await fs.promises.readdir(dir, {withFileTypes: true}); }
    catch { continue; }
    for (const entry of entries) {
      if (++visited > 5000) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 8 && !SKIP.has(entry.name) && !entry.name.startsWith(".")) queue.push({dir: full, depth: depth + 1});
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (CODE.has(ext) || /^(readme|pyproject|package\.json|cargo\.toml)/i.test(entry.name)) {
          files.push(posix(path.relative(root, full)));
        }
      }
    }
  }
  const target = normalize(focus || "");
  let matched = scope ? files.filter(file => !scope.path || file === scope.path || file.startsWith(scope.path + "/"))
    : target ? files.filter(file => normalize(file).includes(target)) : [];
  if (!matched.length && target && !scope) {
    const words = String(focus).toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 2);
    matched = files.filter(file => words.length && words.every(word => normalize(file).includes(word)));
  }
  if (!matched.length && !scope) matched = files.filter(file => CODE.has(path.extname(file).toLowerCase()));
  // Prefer files close to the matched directories, and avoid tests as the
  // first impression of an implementation.
  const score = file => {
    const name = path.basename(file).toLowerCase();
    let value = file.split("/").length;
    if (/test|spec|benchmark/.test(file.toLowerCase())) value += 15;
    if (/^(main|index|app|logic_unit|online_adapter|detector)\./.test(name)) value -= 5;
    if (/^(config|types|dwell|area|scorer|evaluate)/.test(name)) value -= 3;
    return value;
  };
  const selected = matched.filter(file => CODE.has(path.extname(file).toLowerCase())).sort((a, b) => score(a) - score(b) || a.localeCompare(b)).slice(0, scope ? 2000 : 14);
  const readmes = files.filter(file => /(^|\/)readme\.md$/i.test(file))
    .filter(file => !target || normalize(file).includes(target) || file === "README.md")
    .sort((a, b) => Number(normalize(b).includes(target) && !!target) - Number(normalize(a).includes(target) && !!target))
    .slice(0, 4);
  return {selected, readmes, truncated: visited >= 5000 || files.length >= 2500};
}

function stageFor(file) {
  const name = path.basename(file).toLowerCase();
  if (/config|types|schema|model/.test(name)) return 0;
  if (/main|index|app|adapter|input|load|read|parse/.test(name)) return 1;
  if (/scor|classif|decid|detect/.test(name)) return 3;
  if (/eval|test|benchmark|visual|report/.test(name)) return 4;
  return 2;
}

function title(root, focus) {
  return focus && focus.trim() ? focus.trim() : path.basename(root);
}

function notebook(name, stages, readmes, details, scope = null) {
  const out = [`# ${name}: source walkthrough`, "", "ReGain found these source files in the project. Follow the links and source blocks in order. This first pass maps filenames and does not claim to verify runtime behavior.", ""];
  for (const readme of readmes) out.push(`Project context: [${readme}](../${readme})`, "");
  for (let i = 0; i < stages.length; i++) {
    const files = stages[i].files;
    if (!files.length) continue;
    out.push(`## ${i + 1}. ${STAGES[i][1]}`, "", STAGES[i][2], "");
    for (const file of files) {
      const range = scope?.symbol && file === scope.path ? ` ${scope.line}-${scope.end}` : "";
      out.push(`### ${scope?.symbol && file === scope.path ? scope.symbol : path.basename(file)}`, "", details[file] || "Inspect this source file.", "", `Source: [${file}](../${file})`, "", "```file " + file + range, "```", "");
    }
  }
  out.push("## Next step", "", "Inspect the source blocks and add short runnable cells for the project's real inputs. Use the included importance generator for draft highlighting, then review its decision lines against the actual execution path.", "");
  return out.join("\n");
}

function overview(name, stages, readmes, notebookName, truncated, details, context) {
  const cards = stages.filter(stage => stage.files.length).map((stage, index) => {
    const links = stage.files.map(file => `<div class="source"><a href="../${html(file)}">${html(path.basename(file))}</a><small>${html(details[file] || "Source file")}</small></div>`).join("");
    return `<section class="card"><button class="card-head" aria-expanded="false"><span class="num">${String(index + 1).padStart(2, "0")}</span><span><strong>${html(stage.label)}</strong><small>${html(stage.description)}</small></span><span class="chevron">⌄</span></button><div class="details"><div class="files">${links}</div><p>Open a file to inspect the source at this stage.</p></div></section>`;
  }).join("\n");
  const docs = readmes.map(file => `<a href="../${html(file)}">${html(file)}</a>`).join('<span class="sep">·</span>');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(name)} · ReGain</title>
<style>
:root{font-family:Inter,Segoe UI,system-ui,sans-serif;color-scheme:dark;background:#101923;color:#edf4f7;--panel:#1b2a38;--border:#355064;--muted:#a8bfce;--accent:#79dce2}
:root[data-theme="light"]{color-scheme:light;background:#f4f8fa;color:#172a36;--panel:#fff;--border:#ccdae2;--muted:#506675;--accent:#087c87}
*{box-sizing:border-box}body{margin:0;padding:clamp(20px,4vw,48px)}main{max-width:1100px;margin:auto}header{padding:26px 0 18px}.eyebrow{color:var(--accent);font-weight:700;font-size:.76rem;letter-spacing:.16em;text-transform:uppercase}h1{font-size:clamp(2rem,4vw,3.4rem);line-height:1.1;margin:14px 0}.intro{font-size:1.1rem;line-height:1.6;color:var(--muted);max-width:740px}.context{border-left:3px solid var(--accent);padding-left:14px;max-width:760px;color:var(--muted);line-height:1.5}.toolbar{display:flex;flex-wrap:wrap;gap:12px;margin:25px 0 30px}.pill{border:1px solid var(--border);border-radius:999px;padding:9px 15px;color:var(--accent);text-decoration:none}.pill:hover,.files a:hover{text-decoration:underline}.flow{display:grid;grid-template-columns:repeat(auto-fit,minmax(205px,1fr));gap:13px}.card{background:var(--panel);border:1px solid var(--border);border-radius:15px;overflow:hidden}.card-head{display:flex;gap:12px;width:100%;min-height:135px;text-align:left;align-items:flex-start;padding:19px;background:none;border:0;color:inherit;cursor:pointer}.card-head:hover{background:color-mix(in srgb,var(--accent) 8%,transparent)}.num{color:var(--accent);font-size:.78rem;font-weight:800;letter-spacing:.1em;margin-top:4px}strong{display:block;font-size:1.1rem;line-height:1.3}small{display:block;color:var(--muted);line-height:1.45;margin-top:10px}.chevron{margin-left:auto;color:var(--accent);font-size:1.3rem}.details{display:none;border-top:1px solid var(--border);padding:17px 19px}.card.open .details{display:block}.card.open .chevron{transform:rotate(180deg)}.files{display:grid;gap:10px}.files a{color:var(--accent);font-size:.9rem}.source{padding-bottom:8px;border-bottom:1px solid var(--border)}.source:last-child{border:0}.source small{margin-top:3px}.details p,footer{color:var(--muted);font-size:.86rem;line-height:1.5}footer{margin-top:30px;border-top:1px solid var(--border);padding-top:20px}footer a{color:var(--accent)}
</style></head><body><main><header><div class="eyebrow">ReGain · project map</div><h1>${html(name)}</h1><p class="intro">Explore the files ReGain found, then follow the source walkthrough. This map is generated locally from the project tree; open the files to confirm their roles.</p>${context ? `<p class="context">From project documentation: ${html(context)}</p>` : ""}<div class="toolbar"><a class="pill" href="${html(notebookName)}">Open source walkthrough ↗</a><a class="pill" href="understanding.md">Discovery notes ↗</a></div></header><div class="flow">${cards || "<p>No supported source files were found in this folder.</p>"}</div><footer><p>Project documentation: ${docs || "No nearby README found."}</p><p>${truncated ? "Discovery was capped for this large project. Narrow the focus and prepare again for a more specific map." : "Click a stage to see its files. The notebook opens each file in ReGain's interactive source view."}</p></footer></main><script>document.querySelectorAll('.card-head').forEach(button=>button.addEventListener('click',()=>{const card=button.closest('.card');const open=card.classList.toggle('open');button.setAttribute('aria-expanded',String(open));}));</script></body></html>`;
}

async function sourceDetails(root, selected) {
  const details = {};
  for (const file of selected) {
    let source;
    try { source = (await fs.promises.readFile(path.join(root, file), "utf8")).slice(0, 60000); }
    catch { continue; }
    const doc = source.match(/^(?:#![^\n]*\n)?\s*(?:#[^\n]*\n\s*)?[ruRU]{0,2}(?:"""|''')([\s\S]{0,600}?)(?:"""|''')/);
    const intro = doc && doc[1].trim().split(/\n\s*\n/)[0].replace(/\s+/g, " ").slice(0, 210);
    const symbols = [...source.matchAll(/^(?:export\s+)?(?:async\s+)?(?:def|class|function)\s+([A-Za-z_][A-Za-z_0-9]*)/gm)].map(match => match[1]).slice(0, 5);
    details[file] = [intro, symbols.length ? `Defines: ${symbols.join(", ")}.` : ""].filter(Boolean).join(" ") || `Source file: ${path.basename(file)}.`;
  }
  return details;
}

async function documentationContext(root, readmes) {
  for (const file of readmes) {
    try {
      const text = (await fs.promises.readFile(path.join(root, file), "utf8")).replace(/<!--[^]*?-->/g, "");
      const paragraphs = text.split(/\n\s*\n/).map(part => part.replace(/^#+\s*/gm, "").replace(/\[[^\]]+\]\([^)]+\)/g, match => match.slice(1, match.indexOf("]"))).replace(/\s+/g, " ").trim());
      const paragraph = paragraphs.find(part => part.length > 45 && !part.startsWith("!["));
      if (paragraph) return paragraph.slice(0, 320);
    } catch { /* optional context */ }
  }
  return "";
}

async function writeGenerated(file, content) {
  // Preserve anything the user or an agent has edited. On repeat prepares,
  // update only files with our exact generated marker.
  try {
    const old = await fs.promises.readFile(file, "utf8");
    if (!old.includes("REGAIN_GENERATED_V1")) return false;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await fs.promises.writeFile(file, content, "utf8");
  return true;
}

async function generate(root, focus, scope = null) {
  const regain = path.join(root, ".regain");
  await fs.promises.mkdir(regain, {recursive: true});
  const found = await discover(root, focus, scope);
  if (!found.selected.length) throw new Error("No supported source files were found in the selected branch");
  const details = await sourceDetails(root, found.selected);
  const context = await documentationContext(root, found.readmes);
  const stages = STAGES.map(([id, label, description]) => ({id, label, description, files: []}));
  for (const file of found.selected) stages[stageFor(file)].files.push(file);
  const name = title(root, focus);
  const slug = (scope?.path || "project").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(-100) || "project";
  const symbolSlug = scope?.symbol ? `-${scope.symbol.replace(/[^a-z0-9]+/gi, "-")}` : "";
  const notebookName = `selection-${slug}${symbolSlug}.regain.md`;
  const notes = [`<!-- REGAIN_GENERATED_V1 -->`, `# ${name}: discovery notes`, "", "This first pass was generated from file paths. Confirm each role in the source before treating it as a statement of behavior.", "", `Focus: ${focus || "whole project"}`, "", "## Source map", ""];
  if (context) notes.push("## Project documentation", "", context, "", "## Source map", "");
  for (const stage of stages) if (stage.files.length) notes.push(`### ${stage.label}`, "", stage.description, "", ...stage.files.map(file => `- [${file}](../${file}) — ${details[file] || "Source file"}`), "");
  notes.push("## Limits", "", "No code was executed and no dataset was inspected. This map does not establish algorithm correctness or model accuracy.", "");
  const notebookPath = path.join(regain, notebookName);
  const files = [
    [path.join(regain, `selection-${slug}${symbolSlug}.md`), notes.join("\n")],
    [notebookPath, `<!-- REGAIN_GENERATED_V1 -->\n${notebook(name, stages, found.readmes, details, scope)}`],
  ];
  const written = [];
  for (const [file, content] of files) if (await writeGenerated(file, content)) written.push(path.basename(file));
  return {notebookPath, written, selected: found.selected};
}

module.exports = {generate};
