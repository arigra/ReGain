// Live progress for agent calls: each step the agent takes goes to the
// notification and to the "ReGain" output panel, so a long call is never silent.
const path = require("path");

const short = (value, limit = 110) => {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
};

function relative(root, file) {
  if (!file) return "";
  const resolved = path.resolve(root || "", String(file));
  const inside = root && (resolved === root || resolved.startsWith(root + path.sep));
  return inside ? path.relative(root, resolved).split(path.sep).join("/") || "." : String(file);
}

// One Claude Code stream-json event -> readable lines (often none).
function describeClaudeEvent(event, root) {
  if (event?.type !== "assistant") return [];
  const lines = [];
  for (const item of event.message?.content || []) {
    if (item.type === "thinking" && item.thinking?.trim()) lines.push(`Thinking: ${short(item.thinking, 600)}`);
    if (item.type === "text" && item.text?.trim()) lines.push(short(item.text, 160));
    if (item.type !== "tool_use") continue;
    const input = item.input || {};
    switch (item.name) {
      case "Read": lines.push(`Reading ${relative(root, input.file_path)}`); break;
      case "Grep": lines.push(`Searching for "${short(input.pattern, 50)}"${input.path ? ` in ${relative(root, input.path)}` : ""}`); break;
      case "Glob": lines.push(`Listing files matching ${short(input.pattern, 60)}`); break;
      case "LS": lines.push(`Listing ${relative(root, input.path)}`); break;
      case "Bash": lines.push(`Running: ${short(input.description || input.command, 90)}`); break;
      case "Task": case "Agent": lines.push(`Starting a helper: ${short(input.description, 80)}`); break;
      case "StructuredOutput": lines.push("Writing the result"); break;
      case "TodoWrite": break;
      default: lines.push(`Using ${item.name}`);
    }
  }
  return lines;
}

// One Codex exec --json event -> readable lines (often none).
function describeCodexEvent(event) {
  const item = event?.item;
  if (event?.type === "item.started" && item?.type === "command_execution")
    return [`Running: ${short(String(item.command || "").replace(/^(?:\/bin\/)?(?:ba|z)?sh -lc ['"]?|['"]$/g, ""), 90)}`];
  if (event?.type !== "item.completed") return [];
  if (item?.type === "reasoning" && item.text?.trim()) return [short(item.text.replace(/\*\*/g, ""), 160)];
  if (item?.type === "agent_message" && item.text?.trim() && !item.text.trim().startsWith("{")) return [short(item.text, 160)];
  return [];
}

const clock = ms => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

let channel;
function outputChannel() {
  if (!channel) channel = require("vscode").window.createOutputChannel("ReGain");
  return channel;
}

// Tracks one agent call. report(message) updates the notification.
function startProgress(title, report, {log = outputChannel(), now = Date.now, show = true, onStep} = {}) {
  const started = now();
  let steps = 0, last = "Starting the agent…", lastAt = started;
  if (show && log.show) log.show(true);
  log.appendLine(`\n▸ ${title}`);
  // A quiet agent is still working: after a few seconds without events, say so.
  const render = () => {
    const quiet = steps && now() - lastAt > 6000 ? `Thinking… (last: ${last})` : last;
    report?.(`${quiet} · ${steps} step${steps === 1 ? "" : "s"} · ${clock(now() - started)}`);
  };
  const timer = setInterval(render, 1000);
  timer.unref?.();
  render();
  return {
    step(text) {
      if (!text) return;
      steps++;
      last = short(text, 90);
      lastAt = now();
      log.appendLine(`[${clock(now() - started)}] ${text}`);
      onStep?.(text, clock(now() - started));
      render();
    },
    note(text) {
      last = text;
      log.appendLine(`[${clock(now() - started)}] ${text}`);
      render();
    },
    finish(summary) {
      clearInterval(timer);
      log.appendLine(`[${clock(now() - started)}] ${summary || "Done"}`);
      return now() - started;
    },
  };
}

module.exports = {describeClaudeEvent, describeCodexEvent, startProgress, outputChannel, clock};
