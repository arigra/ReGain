// "Draw a visual": one agent call draws an SVG of a block's idea, the code checks it is a safe,
// self-contained picture, and it is saved next to the guide.
const fs = require("fs");
const path = require("path");
const {visualPrompt} = require("./agent-runner");

// A picture shown in the page must not run anything or fetch anything.
function checkSvg(raw) {
  const svg = String(raw || "").trim().replace(/^<\?xml[^>]*>\s*/, "");
  if (!/^<svg[\s>]/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) throw new Error("The agent did not return a complete SVG picture");
  if (svg.length > 300000) throw new Error("The picture is too large");
  if (/<script|<foreignObject|<iframe|<image|\son[a-z]+\s*=|javascript:/i.test(svg)) throw new Error("The picture contains scripts or embedded content");
  if (/(href|src)\s*=\s*["']\s*(https?:|\/\/|data:)/i.test(svg)) throw new Error("The picture links to outside content");
  if (!/viewBox\s*=/i.test(svg)) throw new Error("The picture has no viewBox, so it cannot scale");
  return /xmlns\s*=/.test(svg) ? svg : svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
}

// request: {pageTitle, pageText, target, code, file}, where file is the absolute path to write.
async function makeVisual(root, request, call) {
  const raw = await call("visual", await visualPrompt(root, request), `Drawing a visual for ${request.label || "this block"}`);
  const svg = checkSvg(raw?.svg);
  await fs.promises.mkdir(path.dirname(request.file), {recursive: true});
  await fs.promises.writeFile(request.file, svg + "\n", "utf8");
  return {file: request.file, title: String(raw.title || "").trim()};
}

module.exports = {checkSvg, makeVisual};
