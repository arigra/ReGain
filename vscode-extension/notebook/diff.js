// Which lines of `after` are new or changed relative to `before` (Myers diff).
// Returns {changed: [0-based line indices in after], removed: count of lines only in before}.
function lineChanges(before, after) {
  const a = before.split("\n"), b = after.split("\n");
  const n = a.length, m = b.length, max = n + m;
  const v = new Map([[1, 0]]);
  const trace = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)))
        ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v.set(k, x);
      if (x >= n && y >= m) { found = true; break; }
    }
  }
  // Walk back through the trace to find the inserted and deleted lines.
  const changed = [];
  let removed = 0, x = n, y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const vd = trace[d], k = x - y;
    const down = k === -d || (k !== d && (vd.get(k - 1) ?? -1) < (vd.get(k + 1) ?? -1));
    const pk = down ? k + 1 : k - 1;
    const px = vd.get(pk) ?? 0, py = px - pk;
    while (x > px && y > py) { x--; y--; }
    if (down) changed.push(py); else removed++;
    x = px; y = py;
  }
  return {changed: changed.reverse(), removed};
}

module.exports = {lineChanges};
