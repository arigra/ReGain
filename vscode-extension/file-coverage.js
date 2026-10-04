const fs = require('fs');
const path = require('path');

const skippedDirectories = new Set(['.git', '.regain', '.venv', 'venv', 'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', '.next', '.cache', 'build', 'dist', 'target']);
const binaryExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svgz', '.mp4', '.avi', '.mov', '.mkv', '.wav', '.mp3', '.flac', '.onnx', '.pt', '.pth', '.pb', '.tflite', '.bin', '.exe', '.dll', '.so', '.dylib', '.o', '.obj', '.a', '.lib', '.zip', '.tar', '.gz', '.7z', '.pdf', '.docx', '.xlsx', '.pptx', '.db', '.sqlite', '.npy', '.npz', '.parquet', '.feather', '.pkl', '.pickle', '.class', '.pyc']);
const secretName = /(^\.env(?:\.|$)|(?:secret|credential|private[_-]?key|api[_-]?key|access[_-]?token)|\.(?:pem|key|p12|pfx)$)/i;
const slash = value => value.split(path.sep).join('/');

function sourceOwners(map) {
  const owners = new Map();
  function visit(node) {
    for (const source of node.sources || []) {
      if (!owners.has(source.path)) owners.set(source.path, new Set());
      owners.get(source.path).add(node.id);
    }
    for (const child of node.children || []) visit(child);
  }
  for (const node of map.capabilities || []) visit(node);
  return owners;
}

async function inventory(root, map) {
  const owners = sourceOwners(map);
  const files = [], directories = [];
  async function walk(folder) {
    const entries = await fs.promises.readdir(path.join(root, folder), {withFileTypes: true});
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = slash(path.join(folder, entry.name));
      if (entry.isSymbolicLink()) {
        files.push({path: relative, status: 'excluded', reason: 'Symbolic link outside the checked tree', capabilityIds: []});
        continue;
      }
      if (entry.isDirectory()) {
        if (skippedDirectories.has(entry.name)) directories.push({path: relative, reason: `Generated, dependency, or ReGain directory (${entry.name})`});
        else await walk(path.join(folder, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const capabilityIds = [...(owners.get(relative) || [])];
      if (capabilityIds.length) {
        files.push({path: relative, status: 'mapped', reason: 'Cited in the capability tree', capabilityIds});
        continue;
      }
      if (secretName.test(entry.name)) {
        files.push({path: relative, status: 'excluded', reason: 'Possible secret or credential; contents not read', capabilityIds: []});
        continue;
      }
      const stat = await fs.promises.stat(path.join(root, relative));
      if (binaryExtensions.has(path.extname(entry.name).toLowerCase())) {
        files.push({path: relative, status: 'excluded', reason: 'Binary or non-source asset', capabilityIds: []});
        continue;
      }
      if (stat.size > 2 * 1024 * 1024) {
        files.push({path: relative, status: 'excluded', reason: 'File exceeds 2 MiB analysis limit', capabilityIds: []});
        continue;
      }
      const handle = await fs.promises.open(path.join(root, relative), 'r');
      const sample = Buffer.alloc(Math.min(stat.size, 512));
      try { if (sample.length) await handle.read(sample, 0, sample.length, 0); }
      finally { await handle.close(); }
      if (sample.includes(0)) {
        files.push({path: relative, status: 'excluded', reason: 'Binary content', capabilityIds: []});
        continue;
      }
      files.push({path: relative, status: 'unresolved', reason: 'Awaiting source classification', capabilityIds: []});
    }
  }
  await walk('');
  return {generatedByReGain: true, version: 1, complete: false, files, excludedDirectories: directories};
}

async function resumeCoverage(root, coverage) {
  const target = path.join(root, '.regain', 'file-coverage.json');
  let previous, savedAt;
  try {
    previous = JSON.parse(await fs.promises.readFile(target, 'utf8'));
    savedAt = (await fs.promises.stat(target)).mtimeMs;
  } catch (error) { if (error.code === 'ENOENT') return coverage; throw error; }
  if (!previous.generatedByReGain || !Array.isArray(previous.files)) return coverage;
  const oldFiles = new Map(previous.files.map(file => [file.path, file]));
  for (const file of coverage.files) {
    if (file.status !== 'unresolved') continue;
    const old = oldFiles.get(file.path);
    if (!old || !['supporting', 'excluded', 'new_feature'].includes(old.status) || !old.reason) continue;
    const changed = (await fs.promises.stat(path.join(root, file.path))).mtimeMs > savedAt;
    if (changed) continue;
    file.status = old.status;
    file.reason = old.reason;
    file.capabilityIds = old.capabilityIds || [];
    if (old.featureName) file.featureName = old.featureName;
  }
  return coverage;
}

function coveragePrompt(map, paths) {
  const outline = [];
  function visit(node) {
    outline.push({id: node.id, name: node.name, purpose: node.purpose});
    for (const child of node.children || []) visit(child);
  }
  for (const node of map.capabilities || []) visit(node);
  return `Classify every listed repository file for ReGain's source coverage manifest. Read each file enough to determine its actual role. Return exactly one decision for every listed path, with the path unchanged. Use supporting when the file supports an existing capability; give its exact capabilityId. Use excluded only when the file is genuinely unrelated to this project's behaviors, with a specific reason. Use new_feature when it reveals a meaningful behavior absent from the tree; give the nearest top-level capabilityId and a short featureName. Use unresolved if evidence is insufficient, and explain why. For fields that do not apply, return empty strings. Do not classify source or tests as excluded just because they are not yet cited. Do not read secrets, credentials, large datasets, or external folders. Do not run code or modify files. Return only the requested JSON object. Capabilities: ${JSON.stringify(outline)}. Files: ${JSON.stringify(paths)}.`;
}

function applyDecisions(coverage, raw, paths, map) {
  const expected = new Set(paths), decisions = new Map(), duplicates = new Set();
  const ids = new Set();
  function visit(node) { ids.add(node.id); for (const child of node.children || []) visit(child); }
  for (const node of map.capabilities || []) visit(node);
  for (const decision of raw?.decisions || []) {
    if (!expected.has(decision.path)) continue;
    if (decisions.has(decision.path)) duplicates.add(decision.path);
    else decisions.set(decision.path, decision);
  }
  const files = new Map(coverage.files.map(file => [file.path, file]));
  for (const requested of paths) {
    const file = files.get(requested), decision = decisions.get(requested);
    if (!file) continue;
    let problem = '';
    if (!decision) problem = 'The agent omitted this file from its response';
    else if (duplicates.has(requested)) problem = 'The agent returned duplicate decisions';
    else if (!String(decision.reason || '').trim()) problem = 'The agent returned no reason';
    else if (decision.status === 'supporting' && !ids.has(decision.capabilityId)) problem = 'The agent selected an unknown capability';
    else if (decision.status === 'new_feature' && (!map.capabilities.some(item => item.id === decision.capabilityId) || !String(decision.featureName || '').trim())) problem = 'The agent returned an incomplete new feature';
    else if (!['supporting', 'excluded', 'new_feature', 'unresolved'].includes(decision.status)) problem = 'The agent returned an unknown classification';
    if (problem) {
      file.status = 'unresolved';
      file.reason = problem;
      file.capabilityIds = [];
      file.retry = true;
      delete file.featureName;
      continue;
    }
    file.status = decision.status;
    file.reason = decision.reason.trim();
    file.capabilityIds = ['supporting', 'new_feature'].includes(decision.status) ? [decision.capabilityId] : [];
    if (decision.status === 'new_feature') file.featureName = decision.featureName.trim();
    else delete file.featureName;
    delete file.retry;
  }
}

function completeCoverage(coverage, map) {
  const owners = sourceOwners(map);
  for (const file of coverage.files) {
    if (owners.has(file.path)) {
      file.status = 'mapped';
      file.reason = 'Cited in the capability tree';
      file.capabilityIds = [...owners.get(file.path)];
      delete file.featureName;
    }
    if (file.status === 'new_feature') {
      const matching = [];
      function visit(node) { if (node.name.toLowerCase().includes(file.featureName.toLowerCase())) matching.push(node.id); for (const child of node.children || []) visit(child); }
      for (const node of map.capabilities || []) visit(node);
      if (matching.length) {
        file.status = 'supporting';
        file.capabilityIds = matching;
        delete file.featureName;
      }
    }
  }
  const counts = {mapped: 0, supporting: 0, excluded: 0, unresolved: 0, new_feature: 0};
  for (const file of coverage.files) counts[file.status]++;
  coverage.complete = counts.unresolved === 0 && counts.new_feature === 0;
  coverage.counts = {...counts, total: coverage.files.length, excludedDirectories: coverage.excludedDirectories.length};
  return coverage.counts;
}

async function saveCoverage(root, coverage) {
  const target = path.join(root, '.regain', 'file-coverage.json');
  try {
    const old = JSON.parse(await fs.promises.readFile(target, 'utf8'));
    if (!old.generatedByReGain) throw new Error('Existing file-coverage.json was not generated by ReGain');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.promises.mkdir(path.dirname(target), {recursive: true});
  await fs.promises.writeFile(target, JSON.stringify(coverage, null, 2) + '\n', 'utf8');
}

module.exports = {skippedDirectories, inventory, resumeCoverage, coveragePrompt, applyDecisions, completeCoverage, saveCoverage};
