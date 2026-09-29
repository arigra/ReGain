"""Bridge between the ReGain extension and a Jupyter kernel.

Reads one JSON request per line on stdin, writes one JSON event per line on
stdout. Requests: {"op": "exec", "id", "code"}, {"op": "interrupt"},
{"op": "restart"}, {"op": "shutdown"}. Every exec ends with a "done" event.
"""
import ast
import json
import platform
import queue
import sys
import threading

from jupyter_client import KernelManager
from jupyter_client.kernelspec import KernelSpec

# Edits to project files take effect without restarting the kernel. Plots
# come back as images. The helpers report which variables a run created or
# replaced, with type and shape.
SETUP = r"""
%load_ext autoreload
%autoreload 2
try:
    %matplotlib inline
except Exception:
    pass

def _regain_ids():
    return {k: id(v) for k, v in globals().items() if not k.startswith("_")}

def _regain_vars(before):
    import json, types
    skip = {"In", "Out", "exit", "quit", "get_ipython"}
    out = []
    for k, v in list(globals().items()):
        if k.startswith("_") or k in skip or before.get(k) == id(v):
            continue
        if isinstance(v, (types.ModuleType, types.FunctionType, types.BuiltinFunctionType, type)):
            continue
        shape = getattr(v, "shape", None)
        if shape is not None and not callable(shape):
            info = str(tuple(shape))
            dtype = getattr(v, "dtype", None)
            if dtype is not None:
                info += " " + str(dtype).replace("torch.", "")
        elif isinstance(v, float):
            info = f"{v:.6g}"
        elif isinstance(v, (bool, int, complex)):
            info = repr(v)
        elif isinstance(v, str):
            info = repr(v[:40]) + ("…" if len(v) > 40 else "")
        else:
            try:
                info = f"len {len(v)}"
            except Exception:
                info = ""
        out.append({"name": k, "type": type(v).__name__, "info": info})
    return json.dumps(out)
"""


def emit(**event):
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


def start(cwd):
    # The kernel runs on this same interpreter, not whatever "python3" the
    # installed kernelspecs point to.
    km = KernelManager()
    km._kernel_spec = KernelSpec(
        argv=[sys.executable, "-m", "ipykernel_launcher", "-f", "{connection_file}"],
        display_name="ReGain", language="python")
    km.start_kernel(cwd=cwd)
    kc = km.client()
    kc.start_channels()
    kc.wait_for_ready(timeout=60)
    kc.execute(SETUP, silent=True)
    kc.get_shell_msg(timeout=60)
    return km, kc


def new_vars(kc, msg_id):
    """Variables the run created or replaced, from its execute_reply."""
    while True:
        try:
            reply = kc.get_shell_msg(timeout=10)
        except queue.Empty:
            return None
        if reply["parent_header"].get("msg_id") == msg_id:
            break
    expr = reply["content"].get("user_expressions", {}).get("vars", {})
    if expr.get("status") != "ok":
        return None
    return json.loads(ast.literal_eval(expr["data"]["text/plain"]))


def run(kc, rid, code):
    kc.execute("_regain_before = _regain_ids()", silent=True, store_history=False)
    msg_id = kc.execute(code, user_expressions={"vars": "_regain_vars(_regain_before)"})
    status = "ok"
    while True:
        msg = kc.get_iopub_msg()
        if msg["parent_header"].get("msg_id") != msg_id:
            continue
        kind, c = msg["msg_type"], msg["content"]
        if kind == "stream":
            emit(id=rid, type="stream", name=c["name"], text=c["text"])
        elif kind in ("execute_result", "display_data"):
            emit(id=rid, type="result", data=c["data"])
        elif kind == "error":
            status = "error"
            emit(id=rid, type="error", ename=c["ename"], evalue=c["evalue"],
                 traceback=c["traceback"])
        elif kind == "execute_input":
            emit(id=rid, type="count", count=c["execution_count"])
        elif kind == "status" and c["execution_state"] == "idle":
            break
    found = new_vars(kc, msg_id)
    if found:
        emit(id=rid, type="vars", vars=found)
    emit(id=rid, type="done", status=status)


def main():
    # JSON lines are UTF-8 on every platform (Windows pipes default to the ANSI code page).
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    cwd = sys.argv[1]
    try:
        k = dict(zip(("km", "kc"), start(cwd)))
    except Exception as e:  # no ipykernel in this interpreter, etc.
        emit(type="fatal", message=f"{type(e).__name__}: {e}")
        return
    emit(type="ready", python=sys.executable, version=platform.python_version())

    requests = queue.Queue()

    def read():
        for line in sys.stdin:
            try:
                req = json.loads(line)
            except ValueError:
                emit(type="warning", message=f"bad request: {line[:80]!r}")
                continue
            if req["op"] == "interrupt":
                k["km"].interrupt_kernel()   # must not wait behind a running exec
            else:
                requests.put(req)
        requests.put({"op": "shutdown"})

    threading.Thread(target=read, daemon=True).start()

    while True:
        req = requests.get()
        if req["op"] == "exec":
            run(k["kc"], req["id"], req["code"])
        elif req["op"] == "restart":
            k["kc"].stop_channels()
            k["km"].shutdown_kernel(now=True)
            k.update(zip(("km", "kc"), start(cwd)))
            emit(type="ready", python=sys.executable, version=platform.python_version())
        elif req["op"] == "shutdown":
            k["kc"].stop_channels()
            k["km"].shutdown_kernel(now=True)
            return


if __name__ == "__main__":
    main()
