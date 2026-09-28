// The .regain.md format: plain markdown with two special fences.
//
//   ```file src/train.py            a file block: shows the file itself
//   ```
//   ```file src/radial.py 114-127   the same, lines 114 to 127 only
//   ```
//   ```python                       a code block: runs in the kernel
//   from src.train import train
//   ```
//
// Everything else is text. A file block never holds a copy of the file.

const OPEN = /^```(\S*)\s*(.*)$/;
const CLOSE = /^```\s*$/;

function parse(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let prose = [];
  const flush = () => {
    const src = prose.join("\n").replace(/^\n+|\n+$/g, "");
    if (src.trim()) blocks.push({kind: "text", src});
    prose = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(OPEN);
    const kind = m && (m[1] === "file" ? "file" : m[1] === "python" ? "code" : null);
    if (!kind) { prose.push(lines[i]); continue; }
    let j = i + 1;
    while (j < lines.length && !CLOSE.test(lines[j])) j++;
    if (j === lines.length) { prose.push(lines[i]); continue; }  // unclosed: leave as text
    flush();
    if (kind === "code") {
      blocks.push({kind, src: lines.slice(i + 1, j).join("\n")});
    } else {
      const [path, range] = m[2].trim().split(/\s+/);
      const r = range && range.match(/^(\d+)-(\d+)$/);
      blocks.push({kind, path: path || "", range: r ? [Number(r[1]), Number(r[2])] : null});
    }
    i = j;
  }
  flush();
  return blocks;
}

function serialize(blocks) {
  return blocks.map(b => {
    if (b.kind === "text") return b.src;
    if (b.kind === "code") return "```python\n" + b.src + "\n```";
    const range = b.range ? ` ${b.range[0]}-${b.range[1]}` : "";
    return "```file " + b.path + range + "\n```";
  }).join("\n\n") + "\n";
}

module.exports = {parse, serialize};
