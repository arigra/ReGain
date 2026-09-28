const assert = require("assert");
const {parse, serialize} = require("../notebook/format");

const doc = `# radSeq

## 1 · Data
Read one frame.

\`\`\`file src/radial.py 114-127
\`\`\`

\`\`\`python
from src.radial import power_map
x = power_map(0)

x.shape
\`\`\`

\`\`\`bash
echo stays text
\`\`\`

\`\`\`file src/train.py
\`\`\`
`;

const b = parse(doc);
assert.deepStrictEqual(b.map(x => x.kind), ["text", "file", "code", "text", "file"]);
assert.deepStrictEqual(b[1], {kind: "file", path: "src/radial.py", range: [114, 127]});
assert.strictEqual(b[2].src, "from src.radial import power_map\nx = power_map(0)\n\nx.shape");
assert.ok(b[3].src.includes("echo stays text"));
assert.deepStrictEqual(b[4], {kind: "file", path: "src/train.py", range: null});
assert.strictEqual(serialize(b), doc, "round trip keeps the text");
assert.deepStrictEqual(parse(serialize(b)), b);

// an empty code block survives, an unclosed fence stays text
assert.deepStrictEqual(parse("```python\n\n```\n"), [{kind: "code", src: ""}]);
assert.deepStrictEqual(parse("```python\nx = 1\n").map(x => x.kind), ["text"]);
assert.deepStrictEqual(parse(""), []);
console.log("format: all passed");
