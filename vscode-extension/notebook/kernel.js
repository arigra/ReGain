// One Jupyter kernel per open .regain.md, reached through kernel_bridge.py.
const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const readline = require("readline");

const BRIDGE = path.join(__dirname, "..", "kernel_bridge.py");

// The interpreter the Python extension has selected, else the regain.python setting.
async function pythonFor(uri) {
  const setting = vscode.workspace.getConfiguration("regain").get("python");
  if (setting) return setting;
  try {
    const ext = vscode.extensions.getExtension("ms-python.python");
    if (ext) {
      const api = ext.isActive ? ext.exports : await ext.activate();
      const env = api.environments.getActiveEnvironmentPath(uri);
      if (env && env.path) return env.path;
    }
  } catch (e) { /* fall through */ }
  return "python3";
}

class Kernel {
  constructor(cwd, uri, onEvent, python) {
    this.cwd = cwd;
    this.python = python || null;   // chosen in the kernel picker; else the default
    this.uri = uri;
    this.onEvent = onEvent;   // (event) => void, event.id is the request id
    this.proc = null;
    this.ready = null;
    this.nextId = 1;
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const python = this.python || await pythonFor(this.uri);
      this.onEvent({type: "status", state: "starting", python});
      const proc = cp.spawn(python, ["-u", BRIDGE, this.cwd], {cwd: this.cwd});
      this.proc = proc;
      let stderr = "";
      proc.stderr.on("data", d => { stderr = (stderr + d).slice(-4000); });
      return new Promise((resolve, reject) => {
        proc.on("error", e => {
          this.reset();
          this.onEvent({type: "fatal", message: `Could not start ${python}: ${e.message}`});
          reject(e);
        });
        proc.on("exit", code => {
          if (this.proc !== proc) return;
          this.reset();
          const tail = stderr.split("\n").filter(l => l && !/debugger|frozen|validation/i.test(l)).slice(-6).join("\n");
          this.onEvent({type: "fatal", message: `Kernel stopped (exit ${code}).` + (tail ? "\n" + tail : "")});
          reject(new Error("kernel exited"));
        });
        readline.createInterface({input: proc.stdout}).on("line", line => {
          let ev;
          try { ev = JSON.parse(line); } catch { return; }
          if (ev.type === "ready") { this.onEvent({type: "status", state: "idle", python: ev.python, version: ev.version}); resolve(); }
          else if (ev.type === "fatal") { this.onEvent(ev); proc.kill(); }
          else this.onEvent(ev);
        });
      });
    })();
    this.ready.catch(() => {});
    return this.ready;
  }

  reset() {
    this.proc = null;
    this.ready = null;
  }

  send(req) {
    this.proc.stdin.write(JSON.stringify(req) + "\n");
  }

  // Returns the request id; results arrive through onEvent.
  async exec(code) {
    const id = this.nextId++;
    await this.start();
    this.send({op: "exec", id, code});
    return id;
  }

  interrupt() {
    if (this.proc) this.send({op: "interrupt"});
  }

  async restart() {
    if (!this.proc) return this.start();
    this.onEvent({type: "status", state: "starting"});
    this.send({op: "restart"});
  }

  // Switch interpreter: the running kernel stops, the next run starts the new one.
  setPython(python) {
    this.dispose();
    this.python = python;
    this.onEvent({type: "status", state: "off", python});
  }

  dispose() {
    const proc = this.proc;
    this.reset();
    if (!proc) return;
    try { proc.stdin.write(JSON.stringify({op: "shutdown"}) + "\n"); } catch { /* already gone */ }
    setTimeout(() => proc.kill(), 3000);
  }
}

module.exports = {Kernel, pythonFor};
