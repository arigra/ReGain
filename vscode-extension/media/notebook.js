// View for a .regain.md: text, source file blocks and runnable Python blocks.
(() => {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const root = document.documentElement;

  let name = "", blocks = [], files = {}, visuals = {}, importance = {}, cellImportance = {};
  const importanceLabel = level => ({critical: "Critical", important: "Important",
    supporting: "Skippable"})[level] || level;
  const visualOpen = new Set();   // block keys whose visual panel is open
  let nextKey = 1;
  const out = new Map();          // block key -> [{kind, ...}]
  const counts = new Map();       // block key -> execution count or "*"
  const idToKey = new Map();      // kernel request id -> block key
  let queue = [], running = null, stopOnError = false;
  let kstate = {state: "off", python: "", label: "", version: ""}, banner = "";
  const dirty = new Set();        // file blocks edited here but not saved yet
  const staleOnDisk = new Set();  // ...and changed on disk meanwhile
  const fileRuns = new Map();     // path -> result of the last run (save) of that file
  const ranSrc = new Map();       // code block key -> the source it last ran with
  const varsBy = new Map();       // code block key -> variables its last run created or replaced
  const restored = new Map();     // code block key -> time of an output kept from an earlier session
  // Collapsed headings, by their text; kept in the webview state across reloads.
  const collapsed = new Set((vscode.getState() || {}).collapsed || []);
  const saveCollapsed = () => vscode.setState({...(vscode.getState() || {}), collapsed: [...collapsed]});
  const heading = b => {
    if (b.kind !== "text") return null;
    const m = b.src.split("\n")[0].match(/^(#{1,6})\s+(.*)$/);
    return m ? {level: m[1].length, key: m[0].trim()} : null;
  };
  const isStale = b => ranSrc.has(b.key) && ranSrc.get(b.key) !== b.src;
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
  const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
  function sourceArea(value, {onInput, onKey, readonly, fitter}) {
    const ta = h("textarea", {class: "src", spellcheck: "false", readonly: !!readonly, rows: 1});
    ta.value = value;
    const fit = fitter ? () => fitter(ta) : () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
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

  // ---------- Source highlighting ----------
  const KW = new Set(("False None True and as assert async await break class continue def del elif else except " +
    "finally for from global if import in is lambda nonlocal not or pass raise return try while with yield").split(" "));
  const BUILTIN = new Set(("print len range enumerate zip map filter sum min max abs int float str bool list dict set " +
    "tuple type isinstance super open sorted reversed any all round getattr setattr hasattr iter next repr self cls").split(" "));
  const TOKEN = new RegExp([
    /(#[^\n]*)/.source,                                                        // comment
    /([rRbBuUfF]{0,2}(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?))/.source,  // string
    /(@[\w.]+)/.source,                                                        // decorator
    /(\b\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?j?\b|\.\d+\b)/.source,              // number
    /([A-Za-z_]\w*)/.source,                                                   // name
  ].join("|"), "g");
  const CPP_KW = new Set(("alignas auto bool break case catch char class const constexpr continue decltype default " +
    "delete do double else enum explicit extern false final float for friend if inline int long namespace " +
    "new noexcept nullptr operator override private protected public return short signed sizeof static " +
    "struct switch template this throw true try typedef typename union unsigned using virtual void volatile while").split(" "));
  const CPP_TOKEN = new RegExp([
    /(^[ \t]*#[^\n]*)/.source,                                        // preprocessor
    /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))/.source,           // comment
    /("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?)/.source, // literal
    /(\b\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?\b|\.\d+\b)/.source,
    /([A-Za-z_]\w*)/.source,
  ].join("|"), "gm");
  function highlightLines(src, language = "python") {
    const lines = [[]];
    let last = 0, prev = "";
    const cpp = language === "cpp";
    const add = (cls, text) => text.split("\n").forEach((part, j) => {
      if (j) lines.push([]);
      if (part) lines[lines.length - 1].push(cls ? `<span class="${cls}">${esc(part)}</span>` : esc(part));
    });
    for (const m of src.matchAll(cpp ? CPP_TOKEN : TOKEN)) {
      if (m.index > last) add("", src.slice(last, m.index));
      let cls = cpp
        ? (m[1] ? "dc" : m[2] ? "cm" : m[3] ? "st" : m[4] ? "nu" : "")
        : (m[1] ? "cm" : m[2] ? "st" : m[3] ? "dc" : m[4] ? "nu" : "");
      if (m[5]) cls = cpp
        ? (CPP_KW.has(m[5]) ? "kw" : (prev === "class" || prev === "struct" || prev === "enum") ? "fn" : "")
        : (KW.has(m[5]) ? "kw" : (prev === "def" || prev === "class") ? "fn" : BUILTIN.has(m[5]) ? "bi" : "");
      prev = m[5] || "";
      add(cls, m[0]);
      last = m.index + m[0].length;
    }
    if (last < src.length) add("", src.slice(last));
    return lines.map(l => l.join(""));
  }

  // A code editor: a transparent textarea over a highlighted copy of the same text,
  // with line numbers and per-line marks ({line index: {cls, title}}).
  function codeEditor(value, {start = 1, numbers = false, language = "python", marks = () => ({}), onInput, onKey}) {
    const hl = h("pre", {class: "hl", "aria-hidden": "true"});
    const nums = numbers ? h("div", {class: "nums", "aria-hidden": "true"}) : null;
    let el;
    const fitter = ta => {
      ta.style.height = "auto";
      ta.style.height = ta.scrollHeight + "px";
      const avail = Math.max(0, (el ? el.clientWidth : 0) - (nums ? nums.offsetWidth : 0));
      ta.style.width = avail + "px";
      if (ta.scrollWidth > avail) ta.style.width = ta.scrollWidth + "px";
    };
    const ta = sourceArea(value, {onInput: v => { paint(); onInput && onInput(v); }, onKey, fitter});
    ta.classList.add("over");
    ta.setAttribute("wrap", "off");
    const paint = () => {
      const lines = highlightLines(ta.value, language), mk = marks(ta.value);
      const cls = i => mk[i] ? " " + mk[i].cls : "";
      hl.innerHTML = lines.map((l, i) => {
        const mark = mk[i];
        const title = mark && mark.title ? ` data-line-reason="${esc(mark.title)}"` : "";
        return `<div class="l${cls(i)}"${title}>${l || " "}</div>`;
      }).join("");
      if (nums) nums.innerHTML = lines.map((_, i) =>
        `<div class="n${cls(i)}"${mk[i] && mk[i].title ? ` title="${esc(mk[i].title)}"` : ""}>${start + i}</div>`).join("");
    };
    paint();
    el = h("div", {class: "editor"}, nums, h("div", {class: "srcwrap"}, hl, ta));
    el.ta = ta;
    const tip = h("div", {class: "line-reason-tooltip", role: "tooltip"});
    el.append(tip);
    let reasonTimer = 0;
    let pendingRow = null;
    const showReason = event => {
      // The transparent textarea sits over the highlighted source, so pointer
      // events land on the editor. Resolve the visible source row by its Y position.
      const row = [...hl.querySelectorAll(".l[data-line-reason]")].find(candidate => {
        const rect = candidate.getBoundingClientRect();
        return event.clientY >= rect.top && event.clientY <= rect.bottom;
      });
      if (!row) {
        clearTimeout(reasonTimer);
        pendingRow = null;
        tip.hidden = true;
        return;
      }
      const reason = row.dataset.lineReason;
      if (row === pendingRow) return;
      clearTimeout(reasonTimer);
      pendingRow = row;
      tip.hidden = true;
      const rowBox = row.getBoundingClientRect();
      const left = Math.max(8, Math.min(event.clientX + 14, window.innerWidth - 380));
      const top = Math.min(rowBox.top + 4, window.innerHeight - 70);
      reasonTimer = setTimeout(() => {
        if (pendingRow !== row || !el.isConnected) return;
        tip.textContent = reason;
        tip.style.left = left + "px";
        tip.style.top = top + "px";
        tip.hidden = false;
      }, 500);
    };
    el.addEventListener("pointermove", showReason);
    el.addEventListener("pointerleave", () => {
      clearTimeout(reasonTimer);
      pendingRow = null;
      tip.hidden = true;
    });
    return el;
  }
  window.addEventListener("resize", debounce(() => app.querySelectorAll("textarea.src").forEach(t => t.fit && t.fit()), 100));

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

  function textView(b, i, hidden = 0) {
    const body = h("div", {class: "body"});
    const hd = heading(b);
    const closed = hd && collapsed.has(hd.key);
    const toggle = () => {
      if (closed) collapsed.delete(hd.key); else collapsed.add(hd.key);
      saveCollapsed(); render();
    };
    const show = () => {
      body.replaceChildren();
      const md = h("div", {class: "md", title: "Double-click to edit"});
      md.innerHTML = markdown(closed ? b.src.split("\n")[0] : b.src);
      md.addEventListener("dblclick", edit);
      md.addEventListener("click", e => {
        const a = e.target.closest("a");
        if (!a) return;
        e.preventDefault();
        const [p, l] = a.getAttribute("href").split("#L");
        if (!/^https?:/.test(p)) vscode.postMessage({type: "open", path: p, line: Number(l) || 1});
      });
      body.append(md);
      if (closed) body.append(h("button", {class: "hidden-note", onclick: toggle},
        hidden ? `${hidden} block${hidden === 1 ? "" : "s"} hidden` : "collapsed"));
    };
    const edit = () => {
      const ta = sourceArea(b.src, {onInput: v => { b.src = v; push(); }});
      ta.addEventListener("blur", () => { if (!b.src.trim()) { blocks.splice(blocks.indexOf(b), 1); pushNow(); render(); } else show(); });
      body.replaceChildren(h("div", {class: "box", style: "--c:var(--line);--cs:var(--surface)"}, h("div", {class: "editor"}, ta)));
      ta.focus();
    };
    show();
    if (b.fresh) { delete b.fresh; requestAnimationFrame(edit); }
    const arrow = hd && h("button", {class: "fold", title: closed ? "Expand" : "Collapse",
      "aria-expanded": closed ? "false" : "true", onclick: toggle}, closed ? "▸" : "▾");
    return h("div", {class: "blk text" + (hd ? " h" + hd.level : "")}, h("div", {class: "gut"}, arrow), body, tools(i));
  }

  // Running a file block saves it, changed or not; the extension reports back ("saved").
  function saveFile(p, range) {
    if (!files[p] || files[p].missing) return;
    vscode.postMessage({type: "writeFile", path: p, range, text: files[p].text});
    files[p].saved = files[p].text;
    setDirty(p, false);
    fileRuns.set(p, {state: "saving"});
    const blk = app.querySelector(`.blk.file[data-path="${CSS.escape(p)}"]`);
    if (blk) { blk.querySelector(".state").textContent = ""; blk.querySelector(".count").textContent = "[*]"; }
  }
  function fileResult(p) {
    const r = fileRuns.get(p);
    if (!r || r.state === "saving") return null;
    return r.ok
      ? h("div", {class: "out saved"}, `✓ Saved ${p} · ${r.lines} lines · ${r.time}`)
      : h("div", {class: "out"}, h("span", {class: "error"}, `✗ Could not save ${p}: ${r.error}`));
  }
  const fileState = p => staleOnDisk.has(p) ? "● Unsaved changes · file changed on disk"
    : dirty.has(p) ? "● Unsaved changes · ▶ to save" : "";

  // A file block with unsaved edits turns the "unsaved" colour, and the top bar counts them.
  function setDirty(p, on) {
    if (on) dirty.add(p); else { dirty.delete(p); staleOnDisk.delete(p); }
    const blk = app.querySelector(`.blk.file[data-path="${CSS.escape(p)}"]`);
    if (blk) { blk.classList.toggle("dirty", on); blk.querySelector(".state").textContent = fileState(p); }
    refreshBadge();
  }
  function setStale(b) {
    const stale = isStale(b);
    const blk = app.querySelector(`.blk.code[data-key="${b.key}"]`);
    if (blk) { blk.classList.toggle("stale", stale); blk.querySelector(".stale-note").hidden = !stale; }
    refreshBadge();
  }
  function refreshBadge() {
    const badge = app.querySelector(".unsaved");
    if (badge) badge.replaceWith(unsavedBadge());
  }
  // "● 1 unsaved file · 2 blocks changed since run"; click goes to the first one.
  function unsavedBadge() {
    const nf = dirty.size, nc = blocks.filter(b => b.kind === "code" && isStale(b)).length;
    const parts = [];
    if (nf) parts.push(`${nf} unsaved file${nf === 1 ? "" : "s"}`);
    if (nc) parts.push(`${nc} block${nc === 1 ? "" : "s"} changed since run`);
    return h("button", {class: "unsaved", hidden: !parts.length, title: "Go to the first one",
      onclick: () => {
        const blk = app.querySelector(".blk.file.dirty, .blk.code.stale");
        if (blk) blk.scrollIntoView({block: "center", behavior: "smooth"});
      }}, "● " + parts.join(" · "));
  }

  function fileView(b, i) {
    const f = files[b.path];
    const state = h("span", {class: "state"}, fileState(b.path));
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
      const marks = text => {
        const cur = files[b.path], mk = {};
        if (text === cur.saved) for (const n of cur.changed || []) mk[n - cur.start] = {cls: "chg", title: "Changed since you last looked"};
        const lines = text.split("\n");
        if (text === cur.saved) lines.forEach((_, j) => {
          const sourceIndex = cur.start - 1 + j;
          const importance = (cur.lineImportance || [])[sourceIndex];
          if (importance) mk[j] = {cls: "importance-" + importance,
            title: importanceLabel(importance) + ((cur.lineConfidence || [])[sourceIndex] === "low" ? " (draft)" : "") + ": " +
              ((cur.lineReasons || [])[sourceIndex] || "Supporting code structure or data flow.")};
        });
        for (const x of cur.bites || []) lines.forEach((l, j) => { if (l.includes(x.match)) mk[j] = {cls: "importance-" + (x.importance || "critical"), title: importanceLabel(x.importance || "critical") + ": " + x.why}; });
        return mk;
      };
      const language = /\.(?:cpp|cc|cxx|h|hpp|hh|hxx)$/i.test(b.path) ? "cpp" : "python";
      const ed = codeEditor(f.text, {start: f.start, numbers: true, language, marks,
        onInput: v => {
          files[b.path] = {...files[b.path], text: v};
          setDirty(b.path, v !== files[b.path].saved);
        },
        onKey: e => {
          const save = (e.key === "Enter" && (e.shiftKey || e.metaKey || e.ctrlKey)) ||
                       (e.key === "s" && (e.metaKey || e.ctrlKey));
          if (!save) return;
          e.preventDefault();
          saveFile(b.path, b.range);
          if (e.key === "Enter" && e.shiftKey) focusNext(i);
          return true;
        }});
      ed.ta.dataset.path = b.path;
      body = ed;
    }
    return h("div", {class: "blk file" + (dirty.has(b.path) ? " dirty" : "") + (visualOpen.has(b.key) ? " vopen" : ""), "data-path": b.path},
      h("div", {class: "gut"},
        h("button", {class: "runbtn", title: "Save the file (Shift+Enter)", onclick: () => saveFile(b.path, b.range)}, "▶"),
        h("span", {class: "count"}, !fileRuns.has(b.path) ? "[ ]" :
          fileRuns.get(b.path).state === "saving" ? "[*]" : fileRuns.get(b.path).ok ? "[✓]" : "[!]")),
      h("div", {class: "box"}, bar, body, fileResult(b.path)), sideView(b, i), tools(i));
  }

  // To the right of a file or code block: an arrow that opens its visual panel.
  function sideView(b, i) {
    const vis = b.visual || [];
    const open = visualOpen.has(b.key);
    const toggle = () => { if (open) visualOpen.delete(b.key); else visualOpen.add(b.key); render(); };
    const tab = h("button", {class: "vtab" + (vis.length ? " has" : ""), onclick: toggle,
      title: open ? "Hide the visual" : vis.length ? `Show the visual (${vis.length})` : "Add a visual that explains this block",
      "aria-expanded": open ? "true" : "false"}, open ? "◂" : "▸");
    if (!open) return h("div", {class: "side"}, tab);
    const items = vis.map(v => {
      const info = visuals[v] || {};
      const pic = !info.exists
        ? h("div", {class: "vmissing"}, "Not there yet: " + v)
        : info.image ? h("img", {src: info.uri, alt: v, title: "Open", onclick: () => vscode.postMessage({type: "openVisual", path: v})})
        : h("div", {class: "vmissing"}, v);
      return h("figure", {class: "vfig"}, pic,
        h("figcaption", {},
          h("span", {class: "vname"}, v.split("/").pop()),
          h("button", {class: "tbtn", disabled: !info.exists, onclick: () => vscode.postMessage({type: "openVisual", path: v})}, "Open"),
          h("button", {class: "tbtn", disabled: !info.exists, title: "Open in the system viewer",
            onclick: () => vscode.postMessage({type: "openVisual", path: v, external: true})}, "↗"),
          h("button", {class: "tbtn", title: "Unlink from this block (the file stays)", onclick: () => {
            b.visual = vis.filter(x => x !== v);
            if (!b.visual.length) delete b.visual;
            render(); pushNow();
          }}, "✕")));
    });
    const panel = h("div", {class: "vpanel"},
      h("div", {class: "vhead"}, h("b", {}, "Visual"),
        h("button", {class: "tbtn", title: "Copy a request you can paste to the agent in the side window",
          onclick: () => vscode.postMessage({type: "copyVisualRequest", index: i})}, "Copy request for the agent"),
        h("button", {class: "tbtn", onclick: () => vscode.postMessage({type: "addVisual", index: i})}, "Add image…")),
      items.length ? items : h("p", {class: "vempty"},
        "Nothing here yet. Copy the request and paste it to the agent: it draws a picture of what this block does, saves it next to the page and links it here."));
    return h("div", {class: "side open"}, tab, panel);
  }

  function codeView(b, i) {
    const c = counts.get(b.key);
    const savedCode = b.src;
    const directPlan = cellImportance[savedCode];
    const normalized = source => source.replace(/\r\n/g, "\n").split("\n");
    const codeLines = normalized(b.src);
    const trimIndent = lines => {
      const nonblank = lines.filter(line => line.trim());
      const indent = nonblank.length ? Math.min(...nonblank.map(line => line.match(/^\s*/)[0].length)) : 0;
      return lines.map(line => line.slice(Math.min(indent, line.length)));
    };
    const comparableCode = trimIndent(codeLines);
    const sourcePlan = Object.entries(importance).reduce((found, [path, plan]) => {
      if (found || !plan || !plan.lines) return found;
      const source = files[path] && files[path].text;
      if (!source) return found;
      const sourceLines = normalized(source);
      for (let start = 0; start <= sourceLines.length - codeLines.length; start++) {
        const excerpt = sourceLines.slice(start, start + codeLines.length);
        const comparableSource = trimIndent(excerpt);
        if (comparableCode.every((line, offset) => line === comparableSource[offset])) return {plan, start};
      }
      return found;
    }, null);
    const marks = text => {
      const result = {};
      if (text !== savedCode) return result;
      if (directPlan) {
        codeLines.forEach((_, index) => {
          const level = directPlan.lines[index];
          if (level) result[index] = {cls: "importance-" + level,
            title: importanceLabel(level) + ((directPlan.confidence || [])[index] === "low" ? " (draft)" : "") + ": " +
              ((directPlan.reasons || [])[index] || "Supports this notebook step.")};
        });
        return result;
      }
      if (!sourcePlan) return result;
      codeLines.forEach((_, index) => {
        const sourceIndex = sourcePlan.start + index;
        const level = sourcePlan.plan.lines[sourceIndex];
        if (level) result[index] = {cls: "importance-" + level,
          title: importanceLabel(level) + ((sourcePlan.plan.confidence || [])[sourceIndex] === "low" ? " (draft)" : "") + ": " +
            ((sourcePlan.plan.reasons || [])[sourceIndex] || "Supporting code structure or data flow.")};
      });
      return result;
    };
    const ed = codeEditor(b.src, {marks,
      onInput: v => { b.src = v; push(); setStale(b); },
      onKey: e => {
        if (e.key === "Enter" && (e.shiftKey || e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          run([b.key]);
          if (e.shiftKey) focusNext(i);
          return true;
        }
      }});
    const ta = ed.ta;
    ta.dataset.key = b.key;
    const output = h("div", {class: "out"});
    if (restored.has(b.key)) output.append(h("div", {class: "restored"}, `Output from ${when(restored.get(b.key))} · earlier session`));
    for (const o of out.get(b.key) || []) output.append(outputNode(o));
    const stale = isStale(b);
    return h("div", {class: "blk code" + (running === b.key ? " running" : "") + (stale ? " stale" : "") +
        (visualOpen.has(b.key) ? " vopen" : ""), "data-key": b.key},
      h("div", {class: "gut"},
        h("button", {class: "runbtn", title: "Run (Shift+Enter)", onclick: () => run([b.key])}, "▶"),
        h("span", {class: "count"}, c == null ? "[ ]" : `[${c}]`)),
      h("div", {class: "box"}, ed,
        h("div", {class: "stale-note", hidden: !stale}, "● Changed since last run · the output below is from the previous version · ▶ to run"),
        output, varsRow(b.key)),
      sideView(b, i), tools(i));
  }

  const when = iso => new Date(iso).toLocaleString([], {day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit"});

  // "m ndarray (64, 32) float64 · w float 0.8": what the last run created or replaced.
  function varsRow(key) {
    const vars = varsBy.get(key);
    if (!vars || !vars.length) return null;
    return h("div", {class: "vars"}, vars.map(v =>
      h("span", {class: "var"}, h("b", {}, v.name), " ", h("span", {class: "vt"}, v.type), v.info ? " " + v.info : "")));
  }

  function outputNode(o) {
    if (o.kind === "stream") return h("span", {class: o.name === "stderr" ? "stderr" : ""}, o.text);
    if (o.kind === "warn") return h("span", {class: "warn"}, o.text);
    if (o.kind === "error") return h("span", {class: "error"}, stripAnsi(o.traceback.join("\n")) + "\n");
    const d = o.data;
    if (d["image/png"]) {
      const src = "data:image/png;base64," + d["image/png"];
      const open = () => {
        const overlay = h("div", {class: "plot-lightbox", tabindex: "-1"});
        const close = () => overlay.remove();
        overlay.append(h("button", {class: "plot-close", onclick: close}, "Close"),
          h("img", {src, alt: "Expanded plot"}));
        overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
        overlay.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
        document.body.append(overlay);
        overlay.focus();
      };
      return h("div", {class: "plot-output"},
        h("img", {src, alt: "Plot output", title: "Click to enlarge", onclick: open}),
        h("button", {class: "plot-open", onclick: open}, "Enlarge"));
    }
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
    const labels = {off: "", starting: "starting…", idle: "", busy: "running", dead: "stopped"};
    const kname = kstate.label
      ? kstate.label + (kstate.version ? ` (Python ${kstate.version})` : "")
      : "Select kernel";
    const pick = k => h("label", {},
      h("input", {type: "color", value: hex(getComputedStyle(root).getPropertyValue("--" + k).trim()),
        oninput: e => { colors[k] = e.target.value; applyColors(); saveColors(); }}),
      k === "file" ? "file" : "code");
    return h("div", {class: "top"},
      h("span", {class: "name"}, name),
      unsavedBadge(),
      h("button", {class: "tbtn", onclick: runAll}, "▶ Run all"),
      h("button", {class: "tbtn", onclick: () => { queue = []; vscode.postMessage({type: "interrupt"}); }}, "■ Stop"),
      h("button", {class: "tbtn", onclick: () => { queue = []; counts.clear(); vscode.postMessage({type: "restart"}); render(); }}, "↻ Restart"),
      h("span", {class: "picks"}, pick("file"), pick("code"),
        h("button", {class: "tbtn", onclick: () => { colors = {}; applyColors(); saveColors(); render(); }}, "reset")),
      h("button", {class: "kpick kstate " + kstate.state, title: (kstate.python || "") + "\nClick to change the kernel",
          onclick: () => vscode.postMessage({type: "pickKernel"})},
        h("i"), kname, labels[kstate.state] ? h("span", {class: "kmuted"}, " · " + labels[kstate.state]) : null, " ▾"));
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
    // A collapsed heading hides what follows, up to the next heading of the same or higher level.
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i], hd = heading(b);
      views.push(addBar(i, false));
      if (b.kind !== "text") {
        views.push(b.kind === "file" ? fileView(b, i) : codeView(b, i));
        continue;
      }
      let j = i + 1;
      if (hd && collapsed.has(hd.key)) {
        while (j < blocks.length && !(heading(blocks[j]) && heading(blocks[j]).level <= hd.level)) j++;
      }
      views.push(textView(b, i, j - i - 1));
      i = j - 1;
    }
    views.push(addBar(blocks.length, true));
    app.replaceChildren(...views);
    window.scrollTo(0, scroll);
    if (focusKey) {
      const ta = app.querySelector(`textarea[data-key="${focusKey}"], textarea[data-path="${focusKey}"]`);
      if (ta) { ta.focus(); if (caret != null) ta.setSelectionRange(caret, caret); }
    }
  }

  function focusNext(i) {
    const next = blocks.slice(i + 1).find(b => b.kind !== "text");
    if (!next) return;
    requestAnimationFrame(() => {
      const ta = next.kind === "code"
        ? app.querySelector(`textarea[data-key="${next.key}"]`)
        : app.querySelector(`textarea[data-path="${CSS.escape(next.path)}"]`);
      if (ta) ta.focus();
    });
  }

  // ---------- running ----------
  // Run all: every block in order. A file block "runs" by being saved.
  function runAll() {
    for (const b of blocks) if (b.kind === "file") saveFile(b.path, b.range);
    run(blocks.filter(b => b.kind === "code").map(b => b.key), true);
  }
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
    ranSrc.set(key, b.src);
    varsBy.delete(key);
    restored.delete(key);
    out.set(key, dirty.size ? [{kind: "warn", text:
      `⚠ Unsaved changes in ${[...dirty].join(", ")}. This run uses the saved version; ▶ the file to save it.\n`}] : []);
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
        if (ev.python && ev.python !== kstate.python) kstate.version = "";
        kstate = {...kstate, state: ev.state, python: ev.python || kstate.python,
                  label: ev.label || kstate.label, version: ev.version || kstate.version};
        if (ev.state === "idle") banner = "";
        return render();
      case "fatal":
      case "warning":
        banner = ev.message;
        if (ev.type === "fatal") {
          kstate = {...kstate, state: "dead"};
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
      case "vars": varsBy.set(key, ev.vars); return;
      case "done":
        idToKey.delete(ev.id);
        if (key != null && ranSrc.has(key)) vscode.postMessage({type: "saveOutput", src: ranSrc.get(key),
          entry: {outputs: (out.get(key) || []).filter(o => o.kind !== "warn"), vars: varsBy.get(key) || [], time: new Date().toISOString(), status: ev.status}});
        if (ev.status === "error" && stopOnError) queue = [];
        return next();
    }
  }

  // ---------- messages ----------
  window.addEventListener("message", ({data: m}) => {
    switch (m.type) {
      case "render": {
        name = m.name;
        visuals = m.visuals || {};
        for (const [p, f] of Object.entries(m.files)) {
          if (dirty.has(p) && files[p]) m.files[p] = files[p];   // keep unsaved edits
          else f.saved = f.text;
        }
        files = m.files;
        importance = m.importance || {};
        cellImportance = m.cellImportance || {};
        colors = m.colors || {};
        applyColors();
        // Keep keys (and so outputs) for blocks that stayed in place.
        const old = blocks;
        blocks = m.blocks.map((b, i) => {
          const o = old[i];
          const same = o && o.kind === b.kind && (b.kind !== "code" || o.src === b.src);
          return {...b, key: same ? o.key : nextKey++};
        });
        for (const b of blocks) {
          const kept = b.kind === "code" && !out.has(b.key) && (m.outputs || {})[b.src];
          if (!kept) continue;
          out.set(b.key, kept.outputs || []);
          varsBy.set(b.key, kept.vars || []);
          restored.set(b.key, kept.time);
        }
        return render();
      }
      case "file": {
        if (dirty.has(m.path)) { staleOnDisk.add(m.path); return render(); }
        files[m.path] = {...m.content, saved: m.content.text};
        const ta = app.querySelector(`textarea[data-path="${CSS.escape(m.path)}"]`);
        if (ta && document.activeElement === ta) return;   // don't fight the typist
        return render();
      }
      case "saved": {
        const time = new Date().toLocaleTimeString([], {hour: "2-digit", minute: "2-digit", second: "2-digit"});
        fileRuns.set(m.path, {state: "done", ok: m.ok, lines: m.lines, error: m.error, time});
        if (!m.ok) { dirty.add(m.path); files[m.path].saved = null; }   // still not on disk
        else if (m.content && files[m.path])
          for (const k of ["bites", "lostBites", "changed", "removed"]) files[m.path][k] = m.content[k];
        render();
        const blk = app.querySelector(`.blk.file[data-path="${CSS.escape(m.path)}"]`);
        if (blk) { blk.classList.add("flash"); setTimeout(() => blk.classList.remove("flash"), 700); }
        return;
      }
      case "annot": {
        const f = files[m.path];
        if (!f) return;
        for (const k of ["bites", "lostBites", "changed", "removed"]) f[k] = m.content[k];
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
