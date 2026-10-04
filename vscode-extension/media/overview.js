// The ReGain overview page. Data comes from two globals set before this script:
// map (subjects, story, terms, open questions) and talk (conversation, record, path, guides, times).
window.addEventListener("DOMContentLoaded", () => {
  const api = window.regainApi;
  const $ = id => document.getElementById(id);
  const storyBox = $("story"), readingBox = $("reading"), legendBox = $("legend"), diagram = $("diagram"), search = $("search"),
    questionsBox = $("questions"), termsBox = $("terms"), detail = $("detail"), status = $("status"), uncertain = $("uncertain"),
    guide = $("guide"), guideBar = $("guideBar"), guidePeek = $("guidePeek"), messagesBox = $("messages"), ask = $("ask"),
    askText = $("askText"), aboutBox = $("about"), record = $("record");
  const saved = (api && api.getState && api.getState()) || {};
  let selected = null, ancestors = [], aboutOn = true, pending = false, live = "", liveTime = "", query = "";

  const stateNames = {done: "Done", in_progress: "In progress", not_started: "Not started", unknown: "Unknown"};
  const kindNames = {code: "Code", experiment: "Experiment", status: "Status"};
  const stepsTitle = {code: "How it works", experiment: "The study", status: "Where it stands"};
  const stateOf = node => stateNames[node && node.state] ? node.state : "unknown";

  function el(tag, text, cls) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  }
  function persist() { if (api && api.setState) api.setState({selected: selected && selected.id, guideOpen: guide.classList.contains("open")}); }
  function find(id, nodes = map.capabilities, trail = []) {
    for (const node of nodes || []) {
      if (node.id === id) return {node, trail};
      const child = find(id, node.children || [], trail.concat(node));
      if (child) return child;
    }
    return null;
  }
  function allNodes(nodes = map.capabilities) { return (nodes || []).flatMap(node => [node].concat(allNodes(node.children || []))); }
  function minutes(ms) {
    if (!ms) return "";
    return ms < 60000 ? "under a minute" : "about " + Math.round(ms / 60000) + " min";
  }
  const progress = () => talk.progress || {started: [], covered: []};
  const covered = id => (progress().covered || []).includes(id);
  const started = id => (progress().started || []).includes(id);

  // ---------- words used here: hover text wherever a term appears ----------
  const terms = (map.terms || []).filter(t => t.term && t.meaning).sort((a, b) => b.term.length - a.term.length);
  // Exact case, whole words, and never inside a file path ("radial" in data/radial/split.json is not RADIal).
  const termPattern = terms.length ? new RegExp("(?<![\\w/.-])(" + terms.map(t => t.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")(?![\\w/]|\\.\\w)", "g") : null;
  function wrapTerms(container) {
    if (!termPattern || !container) return;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {acceptNode: node =>
      node.parentElement.closest(".term, button, textarea, input, a, code, summary, dt") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT});
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.nodeValue;
      termPattern.lastIndex = 0;
      if (!termPattern.test(text)) continue;
      termPattern.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0, match;
      while ((match = termPattern.exec(text))) {
        if (match.index > last) frag.append(text.slice(last, match.index));
        const entry = terms.find(t => t.term === match[1]);
        const span = el("span", match[1], "term");
        span.title = entry ? entry.meaning : "";
        span.tabIndex = 0;
        frag.append(span);
        last = match.index + match[1].length;
      }
      if (last < text.length) frag.append(text.slice(last));
      node.replaceWith(frag);
    }
  }

  // ---------- top: the story, and what was read ----------
  function renderStory() {
    storyBox.replaceChildren();
    if (map.story) {
      [["Asks", map.story.asks], ["Done so far", map.story.done], ["Next", map.story.next]].forEach(([label, text]) => {
        const line = el("div", undefined, "line");
        line.append(el("span", label, "label"), el("span", text));
        storyBox.append(line);
      });
    } else storyBox.append(el("p", map.summary || ""));
    wrapTerms(storyBox);
  }
  function renderReading() {
    readingBox.replaceChildren();
    const r = map.reading;
    if (!r || !r.total) return;
    if (r.method === "all" && !(r.unread || []).length) { readingBox.append(el("span", "Every file was read before this map was built (" + r.total + " files). Docs were checked against the code.", "ok")); return; }
    const box = el("details");
    const label = r.method === "all" ? r.read + " of " + r.total + " files were read before this map was built." : "While building this map, the agent read " + r.read + " of " + r.total + " code files.";
    box.append(el("summary", label + ((r.unread || []).length ? " See which were not." : "")));
    if ((r.unread || []).length) { const list = el("ul"); r.unread.forEach(file => list.append(el("li", file))); box.append(list); }
    readingBox.append(box);
  }

  // ---------- the project at a glance ----------
  function renderLegend() {
    legendBox.replaceChildren();
    for (const key of ["done", "in_progress", "not_started", "unknown"]) {
      const item = el("span"), dot = el("i");
      item.dataset.state = key;
      item.append(dot, stateNames[key]);
      legendBox.append(item);
    }
    legendBox.append(el("span", "A green number means you have been through it."));
  }
  function nextToRead() { return (map.capabilities || []).find(node => !covered(node.id)); }
  function matches(node) {
    if (!query) return true;
    return (node.name + " " + node.purpose).toLowerCase().includes(query) || (node.children || []).some(matches);
  }
  function box(node, number) {
    const b = el("button", undefined, "box");
    b.dataset.id = node.id;
    b.dataset.state = stateOf(node);
    b.setAttribute("aria-current", String(!!selected && (selected.id === node.id || ancestors.some(a => a.id === node.id))));
    if (covered(node.id)) b.classList.add("covered");
    if (!matches(node)) b.classList.add("dim");
    const num = el("span", covered(node.id) ? "✓" : String(number), "num");
    num.title = covered(node.id) ? "You have been through this" : "Read this " + (number === 1 ? "first" : "as number " + number);
    b.append(num, el("span", node.name, "name"), el("span", stateNames[stateOf(node)], "state"));
    const next = nextToRead();
    if (next && next.id === node.id) b.append(el("span", covered(node.id) ? "" : (progress().covered || []).length ? "Next" : "Start here", "start"));
    b.title = node.purpose || "";
    b.addEventListener("click", () => { select(node.id); scrollToDetail(); });
    return b;
  }
  function renderDiagram() {
    diagram.replaceChildren();
    const list = map.capabilities || [];
    const firstFlow = list.findIndex(node => node.role !== "side");
    const rows = {above: [], flow: [], below: []};
    list.forEach((node, i) => {
      const where = node.role === "side" ? (firstFlow === -1 || i < firstFlow ? "above" : "below") : "flow";
      rows[where].push([node, i + 1]);
    });
    for (const where of ["above", "flow", "below"]) {
      if (!rows[where].length) continue;
      const row = el("div", undefined, "row" + (where === "flow" ? "" : " side"));
      rows[where].forEach(([node, n], k) => {
        if (where === "flow" && k > 0) row.append(el("span", "→", "arrow"));
        row.append(box(node, n));
      });
      diagram.append(row);
    }
  }

  // ---------- open questions, words, technical notes ----------
  function renderQuestions() {
    const list = map.openQuestions || [];
    questionsBox.hidden = !list.length;
    questionsBox.replaceChildren();
    if (!list.length) return;
    questionsBox.append(el("h2", "Open questions"), el("p", "The files could not settle these. If you know, tell the guide.", "note"));
    const ul = el("ul");
    list.forEach(q => {
      const li = el("li", q);
      const answer = el("button", "Answer in the chat", "link");
      answer.addEventListener("click", () => { askText.value = "About \"" + q + "\": "; openGuide(); askText.focus(); });
      li.append(answer);
      ul.append(li);
    });
    questionsBox.append(ul);
    wrapTerms(ul);
  }
  function renderTerms() {
    termsBox.hidden = !terms.length;
    termsBox.replaceChildren();
    if (!terms.length) return;
    const summary = el("summary", "Words used here ");
    summary.append(el("span", (map.terms || []).map(t => t.term).join(", ")));
    const dl = el("dl");
    (map.terms || []).forEach(t => { dl.append(el("dt", t.term), el("dd", t.meaning)); });
    termsBox.append(summary, dl);
  }
  function renderUncertain() {
    uncertain.replaceChildren();
    const list = map.uncertainties || [];
    if (!list.length) return;
    const box = el("details");
    box.append(el("summary", "Technical notes from the map (" + list.length + ")"));
    const ul = el("ul");
    list.forEach(item => ul.append(el("li", item)));
    box.append(ul);
    uncertain.append(box);
  }

  // ---------- the selected subject ----------
  function select(id) {
    const found = find(id);
    if (!found) return;
    selected = found.node; ancestors = found.trail; aboutOn = true;
    persist(); renderDiagram(); renderDetail(); renderAbout();
  }
  function scrollToDetail() {
    const top = detail.getBoundingClientRect().top;
    if (top > window.innerHeight * 0.6 || top < 0) detail.scrollIntoView({behavior: "smooth", block: "start"});
  }
  function actionButton(label, time, cls, onClick) {
    const b = el("button", label, cls);
    if (time) b.append(el("small", "· " + time));
    b.addEventListener("click", onClick);
    return b;
  }
  function renderDetail() {
    const node = selected;
    detail.replaceChildren();
    if (!node) return;
    const crumb = el("div", undefined, "crumb");
    ancestors.forEach(parent => {
      const back = el("button", parent.name);
      back.addEventListener("click", () => select(parent.id));
      crumb.append(back, el("span", "›"));
    });
    if (ancestors.length) crumb.append(el("span", node.name));
    const tags = el("div", undefined, "tags");
    const statePill = el("span", stateNames[stateOf(node)], "pill state");
    statePill.dataset.state = stateOf(node);
    tags.append(statePill, el("span", kindNames[node.kind] || "Code", "pill kind"));
    detail.append(crumb, tags, el("h2", node.name), el("p", node.purpose, "lead"));

    // the user's own progress on this subject
    const mine = el("div", undefined, "mine");
    const topIndex = (map.capabilities || []).findIndex(item => item.id === node.id);
    if (topIndex >= 0) mine.append(el("span", "Number " + (topIndex + 1) + " of " + map.capabilities.length + " in the reading order."));
    if (started(node.id)) mine.append(el("span", "You opened its guide."));
    const done = el("button", covered(node.id) ? "✓ I've got this" : "I've got this", "toggle");
    done.setAttribute("aria-pressed", String(covered(node.id)));
    done.title = covered(node.id) ? "Mark as not done yet" : "Mark this subject as understood";
    done.addEventListener("click", () => {
      const now = !covered(node.id);
      const p = progress();
      p.covered = now ? [...new Set([...(p.covered || []), node.id])] : (p.covered || []).filter(id => id !== node.id);
      talk.progress = p;
      api.postMessage({type: "markCovered", id: node.id, covered: now});
      renderDiagram(); renderDetail();
    });
    mine.append(done);
    detail.append(mine);

    // actions, named by what you get, with the usual time
    const times = talk.estimates || {};
    const actions = el("div", undefined, "actions");
    const hasGuide = (talk.notebooks || []).includes(node.id);
    const write = () => { status.textContent = "Writing the guide for " + node.name + "…"; api.postMessage({type: "analyzeCapability", id: node.id}); };
    if (hasGuide) {
      actions.append(actionButton("Open its guide", "", "action", () => api.postMessage({type: "openGuide", id: node.id})));
      actions.append(actionButton("Write a fresh guide", minutes(times.guide || times.detail), "action secondary", write));
    } else actions.append(actionButton("Guide me through this", minutes(times.guide || times.detail), "action", write));
    if (!node.refined) actions.append(actionButton("Split into parts", minutes(times.branch), "action secondary", () => {
      status.textContent = "Finding the parts of " + node.name + "…";
      api.postMessage({type: "expandCapability", id: node.id});
    }));
    detail.append(actions);

    // its parts, if it was split
    if ((node.children || []).length) {
      detail.append(el("h3", "Its parts"));
      const parts = el("div", undefined, "parts");
      node.children.forEach(child => {
        const b = el("button", undefined, "box");
        b.dataset.id = child.id;
        b.dataset.state = stateOf(child);
        if (!matches(child)) b.classList.add("dim");
        b.append(el("span", child.name, "name"), el("span", stateNames[stateOf(child)], "state"), el("p", child.purpose));
        b.addEventListener("click", () => select(child.id));
        parts.append(b);
      });
      detail.append(parts);
    }

    // its steps, with where each stands
    if ((node.flow || []).length) {
      detail.append(el("h3", stepsTitle[node.kind] || stepsTitle.code));
      const ol = el("ol", undefined, "flow");
      node.flow.forEach((step, i) => {
        const li = el("li", undefined, "stage");
        li.dataset.n = String(i + 1);
        li.dataset.state = stateOf(step);
        li.append(el("strong", step.label));
        if (step.state && step.state !== "unknown" || node.kind === "status") li.append(el("span", stateNames[stateOf(step)], "state"));
        li.append(el("p", step.description));
        ol.append(li);
      });
      detail.append(ol);
    }

    // how it connects
    const related = (node.related || []).map(id => find(id)).filter(Boolean);
    if (related.length) {
      const row = el("div", undefined, "related");
      row.append(el("span", "Connected to"));
      related.forEach(({node: other}) => {
        const chip = el("button", other.name, "chip");
        chip.addEventListener("click", () => select(other.id));
        row.append(chip);
      });
      detail.append(row);
    }

    // its files, out of the way until wanted
    if ((node.sources || []).length) {
      const files = el("details", undefined, "files");
      files.append(el("summary", "Files behind this (" + node.sources.length + ")"));
      const list = el("div", undefined, "list");
      node.sources.forEach(item => { const a = el("a", item.path); a.href = "../" + item.path; a.title = item.reason || item.path; list.append(a); });
      files.append(list);
      detail.append(files);
    }
    if ((node.refinementNotes || []).length) detail.append(el("p", "Not settled: " + node.refinementNotes.join(" · "), "note"));
    wrapTerms(detail);
  }

  // ---------- the guide ----------
  function openGuide() { guide.classList.add("open"); persist(); }
  guideBar.addEventListener("click", () => { guide.classList.toggle("open"); persist(); });
  function paragraphs(text, parent) {
    const lines = String(text || "").split("\n");
    let para = [], list = null;
    const flush = () => { if (para.length) { parent.append(el("p", para.join(" "))); para = []; } };
    for (const line of lines) {
      if (/^\s*[-*]\s+/.test(line)) { flush(); if (!list) { list = el("ul"); parent.append(list); } list.append(el("li", line.replace(/^\s*[-*]\s+/, ""))); }
      else if (!line.trim()) { flush(); list = null; }
      else { list = null; para.push(line.trim()); flush(); } // agents separate paragraphs with single line breaks
    }
    flush();
  }
  function describeChange(op) {
    const name = id => { const found = find(id); return found ? found.node.name : id; };
    switch (op.op) {
      case "rename": return "Rename " + name(op.id) + " to " + op.name;
      case "describe": return "Reword " + name(op.id);
      case "merge": return "Merge " + (op.ids || []).map(name).join(" and ") + " into " + op.name;
      case "split": return "Split " + name(op.id) + " into " + (op.into || []).map(x => x.name).join(", ");
      case "add": return "Add " + op.name;
      case "remove": return "Remove " + name(op.id);
      case "move": return "Move " + name(op.id);
      case "mark": return "Mark " + name(op.id) + " as " + (stateNames[op.state] || op.state).toLowerCase();
      default: return op.op;
    }
  }
  function renderMessages() {
    messagesBox.replaceChildren();
    const list = talk.conversation || [];
    const lastAgent = [...list].reverse().find(m => m.role === "agent");
    guidePeek.textContent = pending ? (live || "Working…") : lastAgent ? lastAgent.text.split("\n")[0] : "Ask anything about the project";
    if (!list.length && !pending) {
      const start = el("div", undefined, "start-chat");
      start.append(el("p", "Your guide can explain this project in simple terms, answer questions, and reshape the subjects with you."));
      const go = el("button", "Start", "action");
      go.addEventListener("click", () => { pending = true; live = "Starting…"; renderMessages(); api.postMessage({type: "chatStart"}); });
      start.append(go);
      messagesBox.append(start);
      return;
    }
    list.forEach((m, mi) => {
      const bubble = el("div", undefined, "msg " + (m.role === "user" ? "user" : "agent") + (m.status === "error" ? " error" : ""));
      paragraphs(m.text, bubble);
      if ((m.applied || []).length) bubble.append(el("div", "Changed the map: " + m.applied.map(a => a.reason || a.op).join(" · "), "changed"));
      (m.suggested || []).forEach((op, oi) => {
        const card = el("div", undefined, "suggest");
        const refs = [op.id].concat(op.ids || [], op.op === "move" && op.after ? [op.after] : []).filter(Boolean);
        const outdated = op.op !== "add" && refs.some(id => !find(id));
        card.append(el("strong", outdated ? "An earlier suggestion" : describeChange(op)));
        if (op.reason) card.append(el("p", op.reason, "why"));
        if (op.status === "pending" && outdated) card.append(el("div", "Outdated: the subject it refers to has changed since.", "done"));
        else if (op.status === "pending") {
          const yes = el("button", "Apply", "action"), no = el("button", "Skip", "action secondary");
          yes.addEventListener("click", () => { yes.disabled = no.disabled = true; api.postMessage({type: "decideSuggestion", message: mi, index: oi, apply: true}); });
          no.addEventListener("click", () => { yes.disabled = no.disabled = true; api.postMessage({type: "decideSuggestion", message: mi, index: oi, apply: false}); });
          card.append(yes, no);
        } else card.append(el("div", op.status === "applied" ? "Applied." : op.status === "skipped" ? "Skipped." : "Not applied: " + String(op.status).replace(/^not applied: /, ""), "done"));
        bubble.append(card);
      });
      if (m.status === "error" && mi === list.length - 1) {
        const retry = el("button", "Try again", "action secondary");
        retry.style.marginTop = "10px";
        retry.addEventListener("click", () => send(""));
        bubble.append(retry);
      }
      messagesBox.append(bubble);
      if (m.role !== "user") wrapTerms(bubble);
    });
    if (pending) {
      const bubble = el("div", undefined, "msg agent pending"), row = el("div", undefined, "live"), dots = el("span", undefined, "dots");
      dots.append(el("i"), el("i"), el("i"));
      row.append(dots, el("b", live || "Thinking…"));
      if (liveTime) row.append(document.createTextNode(" · " + liveTime));
      bubble.append(row);
      messagesBox.append(bubble);
    }
    messagesBox.scrollTop = messagesBox.scrollHeight;
  }
  function renderAbout() {
    aboutBox.replaceChildren();
    if (!selected || !aboutOn) return;
    aboutBox.append(el("span", "About:"));
    const chip = el("button", selected.name + " ✕");
    chip.title = "Ask about the whole project instead";
    chip.addEventListener("click", () => { aboutOn = false; renderAbout(); });
    aboutBox.append(chip);
  }
  function renderRecord() {
    const l = talk.learner || {};
    const count = ["knows", "cares", "open", "told"].reduce((n, key) => n + (l[key] || []).length, 0);
    const wasOpen = record.open;
    record.replaceChildren();
    const summary = el("summary", "What ReGain thinks you know ");
    summary.append(el("span", count ? "(" + count + ")" : "(nothing yet)"));
    record.append(summary);
    [["You know", l.knows], ["You care about", l.cares], ["Still open for you", l.open], ["You told ReGain", l.told]].forEach(([label, items]) => {
      if (!(items || []).length && label === "You told ReGain") return;
      record.append(el("h3", label));
      if ((items || []).length) { const ul = el("ul"); items.forEach(item => ul.append(el("li", item))); record.append(ul); }
      else record.append(el("p", "Nothing yet.", "none"));
    });
    record.append(el("p", "Wrong? Say so in the chat and it will be corrected.", "note"));
    record.open = wasOpen;
  }
  function send(text) {
    if (pending) return;
    pending = true; live = "Reading your message…"; liveTime = "";
    if (text) talk.conversation = (talk.conversation || []).concat([{role: "user", text}]);
    renderMessages();
    api.postMessage({type: "chat", text, selectedId: selected && aboutOn ? selected.id : ""});
  }
  ask.addEventListener("submit", e => { e.preventDefault(); const text = askText.value.trim(); if (!text) return; askText.value = ""; send(text); });
  askText.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask.requestSubmit(); } });

  // ---------- updates from the extension ----------
  window.addEventListener("message", event => {
    const m = event.data || {};
    if (m.type === "chatProgress") { live = m.text; liveTime = m.time || ""; if (pending) renderMessages(); return; }
    if (m.type !== "state") return;
    for (const key of ["conversation", "learner", "progress", "notebooks", "estimates"]) if (m[key]) talk[key] = m[key];
    pending = !!m.pending;
    if (!pending) { live = ""; liveTime = ""; status.textContent = ""; }
    if (m.map) {
      for (const key of ["capabilities", "summary", "story", "reading", "openQuestions", "terms"]) if (m.map[key] !== undefined) map[key] = m.map[key];
      const keep = selected && find(selected.id);
      const pick = keep || {node: map.capabilities[0], trail: []};
      if (pick && pick.node) { selected = pick.node; ancestors = pick.trail; }
      renderStory(); renderQuestions();
    }
    renderDiagram(); renderDetail(); renderAbout(); renderMessages(); renderRecord();
    (m.glow || []).forEach(id => {
      const node = diagram.querySelector('.box[data-id="' + id + '"]');
      if (node) { node.classList.add("glow"); setTimeout(() => node.classList.remove("glow"), 2700); }
    });
  });

  // ---------- an unfinished analysis, file coverage ----------
  if (map.analysis && map.analysis.status !== "complete") {
    const alert = el("aside");
    alert.style.cssText = "margin:20px 0;padding:13px 16px;border:1px solid #e6aa65;border-radius:10px;background:var(--panel)";
    alert.append(el("strong", "Analysis " + map.analysis.status.replace("_", " ")), el("p", map.analysis.message || "The map is still being checked."));
    if (map.analysis.status !== "in_progress") {
      const retry = el("button", "Resume analysis", "action");
      retry.addEventListener("click", () => { retry.disabled = true; retry.textContent = "Resuming…"; api.postMessage({type: "retryAnalysis"}); });
      alert.append(retry);
    }
    if ((map.analysis.unplaced || []).length) {
      const list = el("ul");
      map.analysis.unplaced.forEach(item => list.append(el("li", item.name + ": " + (item.evidencePaths || []).join(", "))));
      alert.append(list);
    }
    document.querySelector(".glance").before(alert);
  }
  if (map.coverage) {
    const box = el("aside", undefined, "note");
    box.style.cssText = "margin:16px 0";
    box.textContent = (map.analysis && map.analysis.status === "complete" ? "File coverage complete" : "File coverage in progress") + " · " + map.coverage.mapped + " mapped · " + map.coverage.supporting + " supporting · " + map.coverage.excluded + " excluded";
    document.querySelector(".glance").before(box);
  }

  // ---------- first draw ----------
  // Search only helps when there are many subjects.
  search.hidden = allNodes().length <= 12;
  search.addEventListener("input", () => { query = search.value.trim().toLowerCase(); renderDiagram(); renderDetail(); });
  if (saved.guideOpen) guide.classList.add("open");
  renderStory(); renderReading(); renderLegend(); renderQuestions(); renderTerms(); renderUncertain();
  const initial = find(saved.selected) || (nextToRead() ? find(nextToRead().id) : null) || (map.capabilities[0] ? {node: map.capabilities[0], trail: []} : null);
  if (initial) { selected = initial.node; ancestors = initial.trail; }
  renderDiagram(); renderDetail(); renderAbout(); renderMessages(); renderRecord();
});
