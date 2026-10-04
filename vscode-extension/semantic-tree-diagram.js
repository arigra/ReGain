// The overview page: one self-contained HTML file built from the map and the page state.
// Its look and behaviour live in media/overview.css and media/overview.js.
const fs = require("fs");
const path = require("path");

const escapeHtml = value => String(value).replace(/[&<>"']/g, char =>
  ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[char]));
const safeJson = value => JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
const media = name => fs.readFileSync(path.join(__dirname, "media", name), "utf8");

// talk: {conversation, learner, progress, notebooks, estimates}.
function semanticDiagram(map, talk = {}) {
  const state = {
    conversation: talk.conversation || [],
    learner: talk.learner || {knows: [], cares: [], open: [], told: []},
    progress: talk.progress || {started: [], covered: []},
    notebooks: talk.notebooks || [],
    estimates: talk.estimates || {},
  };
  return `<!doctype html><!-- REGAIN_SEMANTIC_V1 -->
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(map.projectName)} · ReGain</title>
<style>${media("overview.css")}</style></head>
<body><main>
<header><div class="eyebrow">ReGain · how this project works</div><h1>${escapeHtml(map.projectName)}</h1>
<section class="story" id="story" aria-label="The project in three lines"></section><div class="reading" id="reading"></div></header>
<section class="glance"><div class="glance-head"><h2>The project at a glance</h2><div class="legend" id="legend"></div></div>
<input class="search" id="search" type="search" placeholder="Find a subject…" aria-label="Find a subject" hidden>
<div class="diagram" id="diagram" aria-label="Subjects in reading order"></div></section>
<div class="extras"><section class="questions" id="questions" hidden></section><details class="terms" id="terms" hidden></details></div>
<div class="work"><section class="detail" id="detail" aria-live="polite"></section>
<aside class="guide" id="guide"><button class="guide-bar" id="guideBar" type="button">Your guide <span id="guidePeek"></span></button>
<div class="guide-body"><h2>Your guide</h2><p class="hint">Ask anything about the project, or say what to merge, split, rename, add or drop on the map.</p>
<div class="messages" id="messages" aria-live="polite"></div>
<form class="ask" id="ask"><div class="about" id="about"></div><div class="ask-row"><textarea id="askText" placeholder="Ask, or say what to change…" aria-label="Message to your guide"></textarea><button class="action" type="submit">Send</button></div></form>
<details class="record" id="record"></details></div></aside></div>
<div id="status" role="status"></div><section class="uncertain" id="uncertain"></section>
</main>
<script>const map=${safeJson(map)};
const talk=${safeJson(state)};</script>
<script>${media("overview.js")}</script></body></html>`;
}

module.exports = {semanticDiagram};
