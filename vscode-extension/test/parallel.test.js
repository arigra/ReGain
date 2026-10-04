// Parallel analysis calls and the model each call uses.
const Module = require("module");
const assert = require("assert");

const settings = {};
const fake = {workspace: {getConfiguration: () => ({get: (key, fallback) => key in settings ? settings[key] : fallback})},
  extensions: {getExtension: () => null}};
const load = Module._load;
Module._load = (req, ...rest) => req === "vscode" ? fake : load(req, ...rest);
const {eachLimited, serialized, cancellationSource} = require("../parallel");
const {modelFor} = require("../agent-runner");

const tick = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // never more than the limit at once, and every item runs
  let running = 0, peak = 0;
  const seen = [];
  await eachLimited([1, 2, 3, 4, 5, 6, 7], 3, null, async item => {
    running++; peak = Math.max(peak, running);
    await tick(5 + (item % 3) * 5);
    seen.push(item);
    running--;
  });
  assert.strictEqual(peak, 3, "three at a time");
  assert.deepStrictEqual(seen.sort(), [1, 2, 3, 4, 5, 6, 7]);

  // a failure cancels the calls still running, stops new ones, and is rethrown
  const started = [], cancelled = [];
  await assert.rejects(eachLimited([1, 2, 3, 4, 5, 6], 2, null, async (item, token) => {
    started.push(item);
    const listener = token.onCancellationRequested(() => cancelled.push(item));   // run() removes it when it ends
    try {
      if (item === 1) { await tick(5); throw new Error("boom"); }
      await tick(30);
    } finally { listener.dispose(); }
  }), /boom/);
  assert.deepStrictEqual(cancelled, [2], "the other running call is cancelled");
  assert.ok(!started.includes(4), "no new calls after the failure");

  // cancelling from outside reaches every running call
  const outer = cancellationSource();
  const stopped = [];
  const done = eachLimited([1, 2], 2, outer.token, async (item, token) => {
    await new Promise(resolve => token.onCancellationRequested(() => { stopped.push(item); resolve(); }));
  });
  outer.cancel();
  await done;
  assert.deepStrictEqual(stopped.sort(), [1, 2]);

  // saves run one at a time, in order, even when requested together
  const writes = [];
  let writing = false;
  const save = serialized(async () => {
    assert.ok(!writing, "no overlapping writes");
    writing = true; writes.push(writes.length); await tick(3); writing = false;
  });
  await Promise.all([save(), save(), save()]);
  assert.deepStrictEqual(writes, [0, 1, 2]);

  // models: Claude defaults to sonnet, haiku for file classification; Codex uses its own config
  assert.strictEqual(modelFor("claude", "map"), "sonnet");
  assert.strictEqual(modelFor("claude", "coverage"), "haiku");
  assert.strictEqual(modelFor("codex", "map"), "");
  Object.assign(settings, {claudeModel: "opus", claudeFastModel: "", codexModel: "gpt-x"});
  assert.strictEqual(modelFor("claude", "coverage"), "opus", "empty fast model falls back to the main one");
  assert.strictEqual(modelFor("codex", "coverage"), "gpt-x");

  console.log("parallel: all passed");
})().catch(e => { console.error(e); process.exit(1); });
