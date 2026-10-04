// Run independent analysis calls side by side, without VS Code types so it can be tested alone.

// A cancellation token in the shape agent-runner expects from VS Code's.
function cancellationSource() {
  const listeners = new Set();
  const token = {
    isCancellationRequested: false,
    onCancellationRequested(listener) {
      listeners.add(listener);
      return {dispose: () => listeners.delete(listener)};
    },
  };
  return {token, cancel() {
    if (token.isCancellationRequested) return;
    token.isCancellationRequested = true;
    for (const listener of [...listeners]) listener();
  }};
}

// Runs `worker(item, token)` over `items`, at most `limit` at a time.
// The first failure cancels the calls still running and is rethrown;
// cancelling `outerToken` cancels them all.
async function eachLimited(items, limit, outerToken, worker) {
  const source = cancellationSource();
  const linked = outerToken?.onCancellationRequested(() => source.cancel());
  let next = 0, failure = null;
  const lane = async () => {
    while (!failure && next < items.length) {
      const item = items[next++];
      try { await worker(item, source.token); }
      catch (error) { if (!failure) { failure = error; source.cancel(); } }
    }
  };
  try { await Promise.all(Array.from({length: Math.min(Math.max(1, limit), items.length)}, lane)); }
  finally { linked?.dispose(); }
  if (failure) throw failure;
}

// Parallel calls finish in any order; their saves must not interleave.
function serialized(write) {
  let queue = Promise.resolve();
  return () => (queue = queue.then(write, write));
}

module.exports = {eachLimited, serialized, cancellationSource};
