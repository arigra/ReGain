// Changes to the top-level subjects that come out of the overview conversation.
// Every change is checked before it is applied: ids must exist, files must be real
// project files, names must be short. A change that fails is reported, not applied.
const fs = require("fs");
const path = require("path");
const {tidy, stateOf} = require("./semantic-map");

const kinds = ["code", "experiment", "status"];
const slug = value => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
const words = value => String(value || "").trim().split(/\s+/).filter(Boolean).length;

function realFile(root, file) {
  if (typeof file !== "string" || !file || path.isAbsolute(file) || file.includes("\\") || file.split("/").includes("..")) return null;
  const target = path.resolve(root, file);
  if (!target.startsWith(path.resolve(root) + path.sep)) return null;
  try { return fs.statSync(target).isFile() ? file : null; } catch { return null; }
}

function freshId(name, taken) {
  const base = slug(name) || "subject";
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  taken.add(id);
  return id;
}

function checkName(name) {
  const value = tidy(String(name || "").trim());
  if (!value) return {error: "the name is empty"};
  if (words(value) > 6) return {error: `"${value}" is longer than 6 words`};
  return {value};
}

function subjectFrom(spec, root, taken) {
  const name = checkName(spec.name);
  if (name.error) return {error: name.error};
  const sources = [...new Set((spec.sources || []).map(file => realFile(root, file)).filter(Boolean))];
  if (!sources.length) return {error: `"${name.value}" names no existing project files`};
  return {subject: {id: freshId(name.value, taken), name: name.value, purpose: tidy(spec.purpose || ""), kind: kinds.includes(spec.kind) ? spec.kind : "code",
    role: "flow", state: stateOf(spec.state),
    runtimeStatus: "unknown", sources: sources.map(file => ({path: file, reason: "Named in the overview conversation"})),
    flow: [], related: [], refined: false, children: []}};
}

// Returns {map, applied: [{op, ids, reason}], rejected: [{op, why}]}. The map is changed in place.
function applyOps(map, ops, root) {
  const applied = [], rejected = [];
  const list = map.capabilities;
  const taken = new Set();
  const collect = items => { for (const item of items || []) { taken.add(item.id); collect(item.children); } };
  collect(list);
  const at = id => list.findIndex(item => item.id === id);
  for (const op of ops || []) {
    const reject = why => rejected.push({op: op.op, why});
    switch (op.op) {
      case "rename": {
        const i = at(op.id);
        if (i < 0) { reject(`no subject "${op.id}"`); break; }
        const name = checkName(op.name);
        if (name.error) { reject(name.error); break; }
        list[i].name = name.value;
        applied.push({op: op.op, ids: [op.id], reason: op.reason});
        break;
      }
      case "describe": {
        const i = at(op.id);
        if (i < 0 || !String(op.purpose || "").trim()) { reject(i < 0 ? `no subject "${op.id}"` : "the description is empty"); break; }
        list[i].purpose = tidy(op.purpose);
        applied.push({op: op.op, ids: [op.id], reason: op.reason});
        break;
      }
      case "merge": {
        const ids = [...new Set(op.ids || [])];
        const found = ids.map(at);
        if (ids.length < 2 || found.some(i => i < 0)) { reject("merge needs at least two existing subjects"); break; }
        const name = checkName(op.name);
        if (name.error) { reject(name.error); break; }
        const parts = found.map(i => list[i]);
        const sources = [];
        for (const part of parts) for (const source of part.sources || []) if (!sources.some(s => s.path === source.path)) sources.push(source);
        // The merged subject keeps the first part's id, so references to it stay valid.
        const merged = {id: parts[0].id, name: name.value, purpose: tidy(op.purpose || parts.map(p => p.purpose).join(" ")),
          kind: parts[0].kind || "code", runtimeStatus: parts[0].runtimeStatus || "unknown", sources,
          flow: parts.flatMap(p => p.flow || []).slice(0, 6), related: [], refined: parts.some(p => p.refined),
          children: parts.flatMap(p => p.children || [])};
        const first = Math.min(...found);
        for (const i of [...found].sort((a, b) => b - a)) list.splice(i, 1);
        list.splice(first, 0, merged);
        applied.push({op: op.op, ids: [merged.id], reason: op.reason});
        break;
      }
      case "split": {
        const i = at(op.id);
        if (i < 0) { reject(`no subject "${op.id}"`); break; }
        if ((op.into || []).length < 2) { reject("a split needs at least two new subjects"); break; }
        const made = (op.into || []).map(spec => subjectFrom(spec, root, taken));
        const failed = made.find(item => item.error);
        if (failed) { reject(failed.error); break; }
        list.splice(i, 1, ...made.map(item => item.subject));
        applied.push({op: op.op, ids: made.map(item => item.subject.id), reason: op.reason});
        break;
      }
      case "add": {
        const made = subjectFrom(op, root, taken);
        if (made.error) { reject(made.error); break; }
        const after = op.after ? at(op.after) : -1;
        list.splice(after >= 0 ? after + 1 : list.length, 0, made.subject);
        applied.push({op: op.op, ids: [made.subject.id], reason: op.reason});
        break;
      }
      case "remove": {
        const i = at(op.id);
        if (i < 0) { reject(`no subject "${op.id}"`); break; }
        if (list.length <= 1) { reject("the map needs at least one subject"); break; }
        list.splice(i, 1);
        applied.push({op: op.op, ids: [], reason: op.reason});
        break;
      }
      case "move": {
        const i = at(op.id);
        if (i < 0) { reject(`no subject "${op.id}"`); break; }
        const [item] = list.splice(i, 1);
        const after = op.after ? at(op.after) : -1;
        if (op.after && after < 0) { list.splice(i, 0, item); reject(`no subject "${op.after}" to move after`); break; }
        list.splice(after + 1, 0, item);
        applied.push({op: op.op, ids: [item.id], reason: op.reason});
        break;
      }
      case "mark": {
        const i = at(op.id);
        if (i < 0) { reject(`no subject "${op.id}"`); break; }
        if (!["done", "in_progress", "not_started", "unknown"].includes(op.state)) { reject(`"${op.state}" is not a state`); break; }
        list[i].state = op.state;
        applied.push({op: op.op, ids: [op.id], reason: op.reason});
        break;
      }
      default:
        reject(`unknown change "${op.op}"`);
    }
  }
  const valid = new Set(list.map(item => item.id));
  for (const item of list) item.related = (item.related || []).filter(id => valid.has(id) && id !== item.id);
  return {map, applied, rejected};
}

module.exports = {applyOps};
