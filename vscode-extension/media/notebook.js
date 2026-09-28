// View for a .regain.md: text, file blocks (the real .py on disk) and code blocks.
(() => {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const root = document.documentElement;

  let name = "", blocks = [], files = {};
  let nextKey = 1;
  const out = new Map();          // block key -> [{kind, ...}]
  const counts = new Map();       // block key -> execution count or "*"
  const idToKey = new Map();      // kernel request id -> block key
  let queue = [], running = null, stopOnError = false;
  let kstate = {state: "off", python: ""}, banner = "";
  let colors = {};

  // ---------- theme and colours ----------
  const theme = () => {
    root.dataset.theme = document.body.classList.contains("vscode-light") ? "light" : "dark";
  };
  theme();
  new MutationObserver(theme).observe(document.body, {attributes: true, attributeFilter: ["class"]});

  function applyColors() {
    for (const k of ["file", "code"]) {
      if (colors[k]) {
        root.style.setProperty("--" + k, colors[k]);
        root.style.setProperty("--" + k + "-soft", `color-mix(in srgb, ${colors[k]} 14%, var(--surface))`);
      } else {
        root.style.removeProperty("--" + k);
        root.style.removeProperty("--" + k + "-soft");
      }
    }
  }
  const hex = c => { const x = document.createElement("canvas").getContext("2d"); x.fillStyle = c; return x.fillStyle; };

  // ---------- helpers ----------
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "class") el.className = v;
      else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k != null) el.append(k);
    return el;
  };
  const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, "");
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const plain = () => blocks.map(({key, ...b}) => b);
  const push = debounce(() => vscode.postMessage({type: "setBlocks", blocks: plain()}), 400);
  const pushNow = () => vscode.postMessage({type: "setBlocks", blocks: plain(), rerender: true});

  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/\*([^*]+)\*/g, "<i>$1</i>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  }
  function markdown(src) {
    const html = [];
    let para = [], list = [], fence = null;
    const flush = () => {
      if (para.length) html.push("<p>" + inline(para.join(" ")) + "</p>");
      if (list.length) html.push("<ul>" + list.map(x => "<li>" + inline(x) + "</li>").join("") + "</ul>");
      para = []; list = [];
    };
    for (const line of src.split("\n")) {
      if (fence) {
        if (/^```/.test(line)) { html.push("<pre>" + esc(fence.join("\n")) + "</pre>"); fence = null; }
        else fence.push(line);
        continue;
      }
      let m;
      if (/^```/.test(line)) { flush(); fence = []; }
      else if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { flush(); html.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); }
      else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { if (para.length) flush(); list.push(m[1]); }
      else if (!line.trim()) flush();
      else { if (list.length) flush(); para.push(line.trim()); }
    }
    if (fence) html.push("<pre>" + esc(fence.join("\n")) + "</pre>");
    flush();
    return html.join("");
  }

  // Textareas that grow with their content, with Tab inserting spaces.
  function sourceArea(value, {onInput, onKey, readonly}) {
    const ta = h("textarea", {class: "src", spellcheck: "false", readonly: !!readonly, rows: 1});
    ta.value = value;
    const fit = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
    ta.addEventListener("input", () => { fit(); onInput && onInput(ta.value); });
    ta.addEventListener("keydown", e => {
      if (onKey && onKey(e)) return;
      if (e.key === "Tab" && !e.shiftKey && !readonly) {
        e.preventDefault();
        ta.setRangeText("    ", ta.selectionStart, ta.selectionEnd, "end");
        ta.dispatchEvent(new Event("input"));
      }
    });
    requestAnimationFrame(fit);
    ta.fit = fit;
    return ta;
  }
  const lineNumbers = (start, n) =>
    h("pre", {class: "nums"}, Array.from({length: Math.max(n, 1)}, (_, i) => start + i).join("\n"));

  // ---------- block views ----------
  function tools(i) {
    const b = blocks[i];
    const move = d => () => {
      const j = i + d;
      if (j < 0 || j >= blocks.length) return;
      [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
      render(); pushNow();
    };
    const del = () => { blocks.splice(i, 1); render(); pushNow(); };
    return h("div", {class: "tools"},
      h("button", {title: "Move up", onclick: move(-1)}, "↑"),
      h("button", {title: "Move down", onclick: move(1)}, "↓"),
      h("button", {title: b.kind === "file" ? "Remove from page (the file stays)" : "Delete", onclick: del}, "✕"));
  }

  function textView(b, i) {
    const body = h("div", {class: "body"});
    const show = () => {
      body.replaceChildren();
      const md = h("div", {class: "md", title: "Double-click to edit"});
      md.innerHTML = markdown(b.src);
      md.addEventListener("dblclick", edit);
      md.addEventListener("click", e => {
        const a = e.target.closest("a");
        if (!a) return;
        e.preventDefault();
        const [p, l] = a.getAttribute("href").split("#L");
        if (!/^https?:/.test(p)) vscode.postMessage({type: "open", path: p, line: Number(l) || 1});
      });
      body.append(md);
    };
    const edit = () => {
      const ta = sourceArea(b.src, {onInput: v => { b.src = v; push(); }});
      ta.addEventListener("blur", () => { if (!b.src.trim()) { blocks.splice(blocks.indexOf(b), 1); pushNow(); render(); } else show(); });
      body.replaceChildren(h("div", {class: "box", style: "--c:var(--line);--cs:var(--surface)"}, h("div", {class: "editor"}, ta)));
      ta.focus();
    };
    show();
    if (b.fresh) { delete b.fresh; requestAnimationFrame(edit); }
    return h("div", {class: "blk text"}, h("div", {class: "gut"}), body, tools(i));
  }

  function fileView(b, i) {
    const f = files[b.path];
    const state = h("span", {class: "state"});
    const bar = h("div", {class: "bar"},
      h("span", {class: "dots"}, h("i"), h("i"), h("i")),
      h("button", {class: "path", title: "Open in the editor",
        onclick: () => vscode.postMessage({type: "open", path: b.path, line: b.range ? b.range[0] : 1})}, b.path),
      b.range ? h("span", {class: "range"}, `lines ${b.range[0]}–${b.range[1]}`) : null,
      state);
    let body;
    if (!f || f.missing) {
      body = h("div", {class: "missing"}, "This file does not exist yet.",
        h("button", {class: "tbtn", onclick: () => vscode.postMessage({type: "createMissing", path: b.path})}, "Create it"));
    } else {
      const text = f.text;
      let nums = lineNumbers(f.start, text.split("\n").length);
      const write = debounce(v => {
        vscode.postMessage({type: "writeFile", path: b.path, range: b.range, text: v});
        state.textContent = "saved";
        setTimeout(() => { state.textContent = ""; }, 1200);
      }, 400);
      const ta = sourceArea(text, {onInput: v => {
        files[b.path] = {...files[b.path], text: v};
        const n = lineNumbers(f.start, v.split("\n").length); nums.replaceWith(n); nums = n;
        state.textContent = "…";
        write(v);
      }});
      ta.dataset.path = b.path;
      body = h("div", {class: "editor"}, nums, ta);
    }
    return h("div", {class: "blk file"}, h("div", {class: "gut"}), h("div", {class: "box"}, bar, body), tools(i));
  }

  function codeView(b, i) {
    const c = counts.get(b.key);
    const ta = sourceArea(b.src, {
      onInput: v => { b.src = v; push(); },
      onKey: e => {
        if (e.key === "Enter" && (e.shiftKey || e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          run([b.key]);
          if (e.shiftKey) focusNextCode(i);
          return true;
        }
      }});
    ta.dataset.key = b.key;
    const output = h("div", {class: "out"});
    for (const o of out.get(b.key) || []) output.append(outputNode(o));
    return h("div", {class: "blk code" + (running === b.key ? " running" : ""), "data-key": b.key},
      h("div", {class: "gut"},
        h("button", {class: "runbtn", title: "Run (Shift+Enter)", onclick: () => run([b.key])}, "▶"),
        h("span", {class: "count"}, c == null ? "[ ]" : `[${c}]`)),
      h("div", {class: "box"}, h("div", {class: "editor"}, ta), output),
      tools(i));
  }

  function outputNode(o) {
    if (o.kind === "stream") return h("span", {class: o.name === "stderr" ? "stderr" : ""}, o.text);
    if (o.kind === "error") return h("span", {class: "error"}, stripAnsi(o.traceback.join("\n")) + "\n");
    const d = o.data;
    if (d["image/png"]) return h("img", {src: "data:image/png;base64," + d["image/png"]});
    if (d["text/html"]) { const el = h("div", {class: "html"}); el.innerHTML = [].concat(d["text/html"]).join(""); return el; }
    return h("span", {}, [].concat(d["text/plain"] || "").join("") + "\n");
  }

  function addBar(at, last) {
    const add = kind => () => {
      if (kind === "file") return vscode.postMessage({type: "addFile", at});
      const b = kind === "text"
        ? {kind, src: "## New section", key: nextKey++, fresh: true}
        : {kind: "code", src: "", key: nextKey++};
      blocks.splice(at, 0, b);
      render(); pushNow();
      if (kind === "code") requestAnimationFrame(() => {
        const ta = app.querySelector(`textarea[data-key="${b.key}"]`); if (ta) ta.focus();
      });
    };
    return h("div", {class: "add" + (last ? " last" : "")},
      h("button", {onclick: add("text")}, "+ Heading"),
      h("button", {onclick: add("file")}, "+ File"),
      h("button", {onclick: add("code")}, "+ Code"));
  }

  function topBar() {
    const labels = {off: "kernel not started", starting: "starting…", idle: "idle", busy: "running", dead: "stopped"};
    const pick = k => h("label", {},
      h("input", {type: "color", value: hex(getComputedStyle(root).getPropertyValue("--" + k).trim()),
        oninput: e => { colors[k] = e.target.value; applyColors(); saveColors(); }}),
      k === "file" ? "file" : "code");
    return h("div", {class: "top"},
      h("span", {class: "name"}, name),
      h("span", {class: "kstate " + kstate.state, title: kstate.python || ""}, h("i"), labels[kstate.state] || kstate.state),
      h("button", {class: "tbtn", onclick: () => run(blocks.filter(b => b.kind === "code").map(b => b.key), true)}, "▶ Run all"),
      h("button", {class: "tbtn", onclick: () => { queue = []; vscode.postMessage({type: "interrupt"}); }}, "■ Stop"),
      h("button", {class: "tbtn", onclick: () => { queue = []; counts.clear(); vscode.postMessage({type: "restart"}); render(); }}, "↻ Restart"),
      h("span", {class: "picks"}, pick("file"), pick("code"),
        h("button", {class: "tbtn", onclick: () => { colors = {}; applyColors(); saveColors(); render(); }}, "reset")));
  }
  const saveColors = debounce(() => vscode.postMessage({type: "colors", colors}), 300);

  function render() {
    const active = document.activeElement;
    const focusKey = active && active.dataset && (active.dataset.key || active.dataset.path);
    const caret = active && active.selectionStart;
    const scroll = window.scrollY;
    const views = [topBar()];
    if (banner) views.push(h("div", {class: "banner"}, banner));
    if (!blocks.length) views.push(h("p", {class: "empty"}, "Empty page. Start with a heading, a file or some code."));
    blocks.forEach((b, i) => {
      views.push(addBar(i, false));
      views.push(b.kind === "text" ? textView(b, i) : b.kind === "file" ? fileView(b, i) : codeView(b, i));
    });
    views.push(addBar(blocks.length, true));
    app.replaceChildren(...views);
    window.scrollTo(0, scroll);
    if (focusKey) {
      const ta = app.querySelector(`textarea[data-key="${focusKey}"], textarea[data-path="${focusKey}"]`);
      if (ta) { ta.focus(); if (caret != null) ta.setSelectionRange(caret, caret); }
    }
  }

  function focusNextCode(i) {
    const next = blocks.slice(i + 1).find(b => b.kind === "code");
    if (!next) return;
    requestAnimationFrame(() => {
      const ta = app.querySelector(`textarea[data-key="${next.key}"]`); if (ta) ta.focus();
    });
  }

  // ---------- running ----------
  function run(keys, all = false) {
    queue.push(...keys);
    stopOnError = all;
    if (!running) next();
  }
  function next() {
    running = null;
    const key = queue.shift();
    if (key == null) return render();
    const b = blocks.find(x => x.key === key);
    if (!b) return next();
    running = key;
    out.set(key, []);
    counts.set(key, "*");
    render();
    vscode.postMessage({type: "run", key, code: b.src});
  }
  function append(key, o) {
    const list = out.get(key) || [];
    const last = list[list.length - 1];
    if (o.kind === "stream" && last && last.kind === "stream" && last.name === o.name) last.text += o.text;
    else list.push(o);
    out.set(key, list);
    const box = app.querySelector(`.blk.code[data-key="${key}"] .out`);
    if (box) { box.replaceChildren(...list.map(outputNode)); box.scrollTop = box.scrollHeight; }
  }

  function onKernel(ev) {
    const key = ev.id != null ? idToKey.get(ev.id) : null;
    switch (ev.type) {
      case "status":
        kstate = {state: ev.state, python: ev.python || kstate.python};
        if (ev.state === "idle") banner = "";
        return render();
      case "fatal":
      case "warning":
        banner = ev.message;
        if (ev.type === "fatal") {
          kstate = {state: "dead", python: kstate.python};
          if (running != null) counts.delete(running);
          queue = []; running = null;
        }
        return render();
      case "count": counts.set(key, ev.count); {
        const g = app.querySelector(`.blk.code[data-key="${key}"] .count`); if (g) g.textContent = `[${ev.count}]`;
      } return;
      case "stream": return append(key, {kind: "stream", name: ev.name, text: ev.text});
      case "result": return append(key, {kind: "result", data: ev.data});
      case "error": return append(key, {kind: "error", traceback: ev.traceback});
      case "done":
        idToKey.delete(ev.id);
        if (ev.status === "error" && stopOnError) queue = [];
        return next();
    }
  }

  // ---------- messages ----------
  window.addEventListener("message", ({data: m}) => {
    switch (m.type) {
      case "render": {
        name = m.name;
        files = m.files;
        colors = m.colors || {};
        applyColors();
        // Keep keys (and so outputs) for blocks that stayed in place.
        const old = blocks;
        blocks = m.blocks.map((b, i) => {
          const o = old[i];
          const same = o && o.kind === b.kind && (b.kind !== "code" || o.src === b.src);
          return {...b, key: same ? o.key : nextKey++};
        });
        return render();
      }
      case "file": {
        files[m.path] = m.content;
        const ta = app.querySelector(`textarea[data-path="${CSS.escape(m.path)}"]`);
        if (ta && document.activeElement === ta) return;   // don't fight the typist
        return render();
      }
      case "range":
        for (const b of blocks) if (b.kind === "file" && b.path === m.path && b.range &&
            b.range[0] === m.from[0] && b.range[1] === m.from[1]) b.range = m.to;
        return;
      case "runStarted":
        idToKey.set(m.id, m.key);
        kstate = {...kstate, state: "busy"};
        return;
      case "runFailed":
        counts.delete(m.key);
        return next();
      case "kernel":
        if (m.ev.type === "done" && !queue.length) kstate = {...kstate, state: "idle"};
        return onKernel(m.ev);
    }
  });

  vscode.postMessage({type: "ready"});
})();
