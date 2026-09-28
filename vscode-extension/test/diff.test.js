const assert = require("assert");
const {lineChanges} = require("../notebook/diff");

assert.deepStrictEqual(lineChanges("a\nb\nc", "a\nb\nc"), {changed: [], removed: 0});
assert.deepStrictEqual(lineChanges("a\nb\nc", "a\nX\nb\nc"), {changed: [1], removed: 0});
assert.deepStrictEqual(lineChanges("a\nb\nc", "a\nc"), {changed: [], removed: 1});
assert.deepStrictEqual(lineChanges("a\nb\nc", "a\nB\nc"), {changed: [1], removed: 1});
assert.deepStrictEqual(lineChanges("", "x\ny"), {changed: [0, 1], removed: 1});
assert.deepStrictEqual(lineChanges("a\nb", ""), {changed: [0], removed: 2});

// random edits: every unchanged line of `after` must be matched in order in `before`
let seed = 7;
const rnd = k => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % k;
for (let t = 0; t < 300; t++) {
  const a = Array.from({length: rnd(30)}, () => "l" + rnd(6));
  const b = a.slice();
  for (let e = rnd(6); e > 0; e--) {
    const op = rnd(3), i = rnd(b.length + 1);
    if (op === 0) b.splice(i, 0, "n" + rnd(6)); else if (op === 1) b.splice(i, 1); else b[i] = "c" + rnd(6);
  }
  const {changed, removed} = lineChanges(a.join("\n"), b.join("\n"));
  const A = a.join("\n").split("\n"), B = b.join("\n").split("\n");   // as the diff sees them
  const kept = B.filter((_, i) => !changed.includes(i));
  let j = 0;
  for (const line of A) if (j < kept.length && line === kept[j]) j++;
  assert.strictEqual(j, kept.length, "kept lines are a subsequence of before");
  assert.strictEqual(A.length - removed, kept.length, "counts add up");
}
console.log("diff: all passed");
