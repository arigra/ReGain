const {spawn} = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const vscode = require("vscode");

const string = {type: "string"};
const source = {type: "object", additionalProperties: false, properties: {path: string, reason: string}, required: ["path", "reason"]};
const mapSchema = {
  type: "object", additionalProperties: false,
  properties: {
    projectName: string, summary: string,
    capabilities: {type: "array", items: {type: "object", additionalProperties: false,
      properties: {id: string, name: string, purpose: string, runtimeStatus: {type: "string", enum: ["runtime", "research", "evaluation", "tooling", "unknown"]},
        sources: {type: "array", items: source},
        flow: {type: "array", items: {type: "object", additionalProperties: false,
          properties: {id: string, label: string, description: string, sources: {type: "array", items: string}},
          required: ["id", "label", "description", "sources"]}},
        related: {type: "array", items: string}},
      required: ["id", "name", "purpose", "runtimeStatus", "sources", "flow", "related"]}},
    uncertainties: {type: "array", items: string},
  },
  required: ["projectName", "summary", "capabilities", "uncertainties"],
};
const branchSchema = {
  type: "object", additionalProperties: false,
  properties: {
    children: {type: "array", items: {type: "object", additionalProperties: false,
      properties: {id: string, name: string, purpose: string,
        runtimeStatus: {type: "string", enum: ["runtime", "research", "evaluation", "tooling", "unknown"]},
        sources: {type: "array", items: source},
        flow: {type: "array", items: {type: "object", additionalProperties: false,
          properties: {id: string, label: string, description: string, sources: {type: "array", items: string}},
          required: ["id", "label", "description", "sources"]}}},
      required: ["id", "name", "purpose", "runtimeStatus", "sources", "flow"]}},
    uncertainties: {type: "array", items: string},
  }, required: ["children", "uncertainties"],
};
const auditSchema = {
  type: "object", additionalProperties: false,
  properties: {missing: {type: "array", items: {type: "object", additionalProperties: false,
    properties: {name: string, parentId: string, evidencePaths: {type: "array", items: string}},
    required: ["name", "parentId", "evidencePaths"]}}},
  required: ["missing"],
};
const coverageSchema = {
  type: "object", additionalProperties: false,
  properties: {decisions: {type: "array", items: {type: "object", additionalProperties: false,
    properties: {path: string, status: {type: "string", enum: ["supporting", "excluded", "new_feature", "unresolved"]},
      capabilityId: string, featureName: string, reason: string},
    required: ["path", "status", "capabilityId", "featureName", "reason"]}}},
  required: ["decisions"],
};
const detailSchema = {
  type: "object", additionalProperties: false,
  properties: {
    overview: string,
    sequence: {type: "object", additionalProperties: false,
      properties: {
        participants: {type: "array", items: {type: "object", additionalProperties: false,
          properties: {id: string, name: string}, required: ["id", "name"]}},
        messages: {type: "array", items: {type: "object", additionalProperties: false,
          properties: {from: string, to: string, label: string}, required: ["from", "to", "label"]}},
      }, required: ["participants", "messages"]},
    stages: {type: "array", items: {type: "object", additionalProperties: false,
      properties: {name: string, explanation: string,
        demonstrations: {type: "array", items: {type: "object", additionalProperties: false,
          properties: {title: string, explanation: string, code: string, observation: string, language: {type: "string", enum: ["python", "shell"]}},
          required: ["title", "explanation", "code", "observation", "language"]}},
        sources: {type: "array", items: {type: "object", additionalProperties: false,
          properties: {path: string, role: string, startLine: {type: "integer"}, endLine: {type: "integer"}},
          required: ["path", "role", "startLine", "endLine"]}}},
      required: ["name", "explanation", "sources", "demonstrations"]}},
    decisions: {type: "array", items: {type: "object", additionalProperties: false,
      properties: {path: string, line: {type: "integer"}, match: string,
        importance: {type: "string", enum: ["critical", "important", "supporting"]}, why: string},
      required: ["path", "line", "match", "importance", "why"]}},
    unresolved: {type: "array", items: string},
  },
  required: ["overview", "sequence", "stages", "decisions", "unresolved"],
};

function executable() {
  const extension = vscode.extensions.getExtension("openai.chatgpt");
  if (extension) {
    const platforms = process.platform === "win32" ? ["windows-x86_64"]
      : process.platform === "darwin" ? ["macos-aarch64", "macos-x86_64"] : ["linux-x86_64", "linux-aarch64"];
    for (const platform of platforms) {
      const candidate = path.join(extension.extensionPath, "bin", platform, process.platform === "win32" ? "codex.exe" : "codex");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return "codex";
}

function mapPrompt() {
  return `Analyze this repository to build a semantic capability map for ReGain. Read the actual source, entry points, configuration, public interfaces, tests, and nearby documentation. Trace calls and data flow before naming capabilities. A capability is something the project does; it may span several directories. Merge implementations and adapters of the same feature under one capability. Distinguish runtime behavior from experiments, evaluation, and tooling. Follow cross-package imports and call sites. Search public output fields, configuration keys, named logic units, feature tests, and design docs for named user-visible behaviors. Ensure every major named behavior has a clear place in the map, even when several belong under one broad capability. Do not infer architecture merely from folder names. Cover the major verified capabilities, not just the first directory you encounter. Each capability needs an ordered execution flow, exact project-relative source paths, and a stable id. Related entries must refer to those ids. Include only claims backed by source paths. If a relationship cannot be verified, state it in uncertainties. Work as long as needed for a reliable map. Do not read secrets, credentials, large datasets, or unrelated external folders. Do not run project code or modify files. Return only the requested JSON object.`;
}

function detailPrompt(capability) {
  return `Analyze the repository capability "${capability.name}": ${capability.purpose}.
The resulting ReGain page is an interactive notebook, so code cells are a core deliverable. If this is a Python capability with an importable public API, include at least two substantial demonstrations overall: a minimal input-to-output example and one example that changes a branch, state, or calculation. Print the meaningful values so the reader can see the output, and describe what to expect. If the API is currently broken, still include a safe runnable diagnostic cell that exposes the exact blocker; do not imply the feature itself ran. Empty demonstrations arrays are appropriate only for individual stages with no useful small example.
Keep sequence participant names to one to three short words and each arrow label to a short action. Explain detail in the stage prose, so the diagram stays readable. For every cited source file or file section, write its role in one or two plain-language sentences: what it receives, what it does, and what it passes onward. Avoid labels such as "scoring logic" that do not explain the behavior, and avoid repeating the stage summary verbatim.
Stay within the selected capability. If a shared orchestrator also invokes sibling features, explain only the calls and output fields needed for this selection. Follow feature-specific helpers, configurations, and tests even if they were not listed among the initial sources; omit unrelated sibling implementations.
Read its source paths, callers, downstream outputs, configuration, tests, and relevant documentation. Trace the actual execution path across directories. Explain each stage in plain language with exact project-relative source files and line ranges. Provide a concise chronological sequence of real calls and data transfers, with short participant IDs and names; include the caller, main components, and returned result. For each stage, provide runnable demonstrations when a small safe synthetic example can show the behavior. Use language python only for real Python APIs. For C++ and other compiled capabilities, use language shell with verified project build or test commands that execute the actual compiled code, and explain prerequisites. Never use Python merely to read source, simulate C++ logic, or wrap a shell command. Use the real public API and current signatures. Make cells self-contained or explicitly depend on earlier cells, print or display the meaningful inputs and outputs, and explain what the user should observe. Prefer a few high-value examples over many trivial cells. If a stage cannot reasonably run without private data, special hardware, a service, or significant setup, return an empty demonstrations array and explain that in its prose. Never invent APIs or pretend an unverified example works. Do not include secrets, destructive actions, downloads, network calls, or writes outside the notebook. Review important decision/calculation lines against downstream behavior; return exact line text, one-based line numbers, a critical/important/supporting rating, and a specific reason. Include unresolved questions instead of guessing. You may take as long as needed. Do not read secrets, credentials, large datasets, or unrelated external folders. Do not run project code or modify files. Return only the requested JSON object. Initial sources: ${capability.sources.map(item => item.path).join(", ")}.`;
}

function branchPrompt(capability) {
  return `Refine this ReGain capability into meaningful child capabilities: "${capability.name}". Purpose: ${capability.purpose}.
Read its cited sources and trace related callers, callees, outputs, tests, and configuration across the repository. Search named logic units, output fields, configuration switches, tests, and design docs for distinct features that may be hidden beneath a broad label; include them even if they were absent from the initial sources. Divide this branch by independently understandable user-visible behaviors, not by folders, files, generic pipeline stages, or arbitrary equal-sized groups. For example, expression, seatbelt, smoking, phone, and drinking detection may be separate children if source confirms distinct behavior. Include every verified named behavior in an appropriately named child. Include only real child capabilities supported by exact project-relative paths. Each child must include its own feature-specific sources AND the minimum shared entry, scheduling, and output sources needed for a self-contained notebook. Give each child a short ordered flow. Do not repeat unrelated siblings in a child's sources. Preserve important distinctions between runtime, evaluation, and tooling. If this branch has no meaningful further split, return an empty children array. Do not invent features. You may take as long as needed. Do not read secrets, credentials, large datasets, or unrelated external folders. Do not run project code or modify files. Return only the requested JSON object. Initial sources: ${capability.sources.map(item => item.path).join(", ")}.`;
}

function auditPrompt(map) {
  const outline = map.capabilities.map(parent => ({id: parent.id, name: parent.name,
    children: (parent.children || []).map(child => child.name)}));
  return `Independently audit this ReGain capability tree against the repository source. Search public output fields, configuration, feature-specific classes and functions, tests, and design documentation for named user-visible behaviors. Return only important behaviors that are absent by name and meaning from the tree; do not list implementation helpers, synonyms, or already represented features. For each omission, identify the existing top-level parent id where it belongs and cite exact project-relative source paths. Investigate beyond the tree's initially cited files. An omitted behavior may be hidden in a shared orchestrator. Do not read secrets, credentials, large datasets, or unrelated external folders. Do not run project code or modify files. Return only the requested JSON object. Current tree: ${JSON.stringify(outline)}.`;
}

async function run(root, kind, prompt, token, onProgress) {
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), "regain-schema-"));
  const schemaPath = path.join(temporary, "output.schema.json");
  await fs.promises.writeFile(schemaPath, JSON.stringify(kind === "map" ? mapSchema : kind === "branch" ? branchSchema : kind === "audit" ? auditSchema : kind === "coverage" ? coverageSchema : detailSchema), "utf8");
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(executable(), ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--json", "--output-schema", schemaPath, "-C", root, "-"],
        {cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]});
      let finalText = "", errorText = "", failure = "", cancelled = false;
      const cancellation = token?.onCancellationRequested(() => { cancelled = true; child.kill(); });
      child.stdin.on("error", () => {});
      child.stderr.on("data", chunk => { errorText = (errorText + chunk.toString()).slice(-4000); });
      readline.createInterface({input: child.stdout}).on("line", line => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.type === "item.completed" && event.item?.type === "agent_message") finalText = event.item.text || "";
        if (event.type === "turn.failed") failure = event.error?.message || "Agent turn failed";
        if (event.type === "item.started" && event.item?.type === "command_execution") onProgress?.("Tracing source and dependencies…");
        if (event.type === "turn.completed") onProgress?.("Validating the agent's map…");
      });
      child.on("error", error => { cancellation?.dispose(); reject(error); });
      child.on("close", code => {
        cancellation?.dispose();
        if (cancelled) return reject(new Error("Analysis cancelled"));
        if (code !== 0 || failure) return reject(new Error(failure || errorText || `Codex exited with code ${code}`));
        try { resolve(JSON.parse(finalText)); }
        catch { reject(new Error("Codex returned invalid structured analysis")); }
      });
      child.stdin.end(prompt);
    });
  } finally {
    await fs.promises.rm(temporary, {recursive: true, force: true});
  }
}

module.exports = {run, mapPrompt, branchPrompt, auditPrompt, detailPrompt, mapSchema, branchSchema, auditSchema, coverageSchema};
