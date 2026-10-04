# ReGain for VS Code

Click the ReGain icon in the Activity Bar to prepare the current project,
choose another project folder, or create an empty folder. Preparing a project
opens `.regain/overview.html` while the selected AI provider traces the repository. When the
read-only analysis finishes, the page becomes a capability diagram built from
the actual execution paths, even when one feature spans several directories.
Preparation automatically examines every top-level capability for named child
features before showing the completed diagram. This can take several minutes
for a large repository; the progress notification names the branch being read.
ReGain then checks for named features still missing from the tree and revisits
those branches. If discovery fails, ReGain shows an error instead of a completed map. You can
still expand a child capability to look deeper, and ReGain caches that result in
`.regain/semantic-map.json`. Select a parent for a broad notebook or a child for a focused one;
Preparation also inventories repository files into `.regain/file-coverage.json`.
Every candidate text file is either cited in the capability tree, linked as a
supporting file, or excluded with a specific reason. Files that reveal missing
features trigger another branch analysis. Unresolved files prevent a completed
overview. The overview shows coverage counts and links to the full manifest.
ReGain skips dependency, generated, cache, environment, and its own directories;
it records each skipped directory and why. Binary assets, possible secrets, and
files over 2 MiB are listed as excluded without reading their contents.
the selected scope and verified source files are shown before creation. Choose
**Create notebook for this scope** for a source walkthrough and
reviewed line reasons. ReGain validates source references before saving the
agent's structured output under `.regain/`. Unreviewed colors remain marked as
drafts. ReGain uses the installed Codex or Claude Code CLI automatically. If both
are installed, it asks which one to use when analysis starts. The Claude Code CLI
must be on `PATH`, or set **ReGain: Claude Executable** to its absolute path.
Codex is available through the Codex VS Code extension or on `PATH`.
ReGain does not install either CLI. Preparing a project sends its source-derived
contents to the selected provider.
Detailed capability pages start with a sequence diagram and include small
runnable examples where the agent can verify a real API and use synthetic input.
Code under `REGAIN_EXAMPLES_BEGIN` and `REGAIN_EXAMPLES_END` in an existing page
is kept when that capability is analyzed again.

Two views, both opened by clicking the file:

- `.regain/*.html`: an interactive page. File links (relative paths, optional `#L<line>`) open in the editor.
- `*.regain.md`: a notebook-style page. Plain markdown text, plus two fences:

      ```file src/train.py          shows the real file; typing edits it on disk
      ```
      ```file src/radial.py 114-127 only those lines
      ```
      ```python                     runs in a Jupyter kernel started in the project root
      ```shell                      runs in the project root with PowerShell on Windows or sh elsewhere
      from src.train import train
      ```

  ▶ next to a code block runs it; ▶ next to a file block saves the file (typing alone does
  not). Shift+Enter does the same and moves on. Saved files are picked up by the kernel
  without a restart (`%autoreload 2`).

  The kernel button at the top right picks the Python, like Jupyter's "Select Kernel".
  Default: `regain.python`, else the Python extension's interpreter, else `python3`. It
  needs `jupyter_client` and `ipykernel`.

  Also in these pages:
  - Python highlighting in Python files and runnable blocks; C++ highlighting
    in C++ source file blocks.
  - Red, yellow, and green lines from `.regain/line-importance.json` mark
    critical, important, and first-pass skippable code. Hover for the reason.
    The same colors work in source file blocks and runnable Python blocks.
    `.regain/bites.json` can supply focused explanations with `file`, a unique
    `match`, `why`, and `importance`. The old notes list under file blocks is hidden.
  - Long file blocks grow to a window-relative height before scrolling.
  - Python source file blocks start minimized. Select **Expand source** to see
    the full highlighted source and **Minimize source** to close it again.
  - Lines changed since you last looked at a file (by an agent, another editor), until
    "Mark as seen". Your own saves count as seen.
  - Under each code block, the variables its run created or replaced, with type and shape.
  - Outputs are kept in `<page>.regain.outputs.json` next to the page and shown again,
    marked as from an earlier session. Plots (matplotlib) show inline.

  - A ▸ arrow on the right of each file and code block opens its visual panel: pictures
    that explain the block, linked with `visual=visuals/x.svg` on the block's fence (paths
    relative to the page). "Copy request for the agent" writes a ready request with where
    to save and how to link; "Add image…" copies a picture from disk; "Open" shows it in
    VS Code, ↗ in the system viewer.

To see either file as text: right-click → Open With… → Text Editor.

Build, test, install:

    npm install
    REGAIN_PYTHON=python3 npm test
    npx @vscode/vsce package --allow-missing-repository --skip-license
    code --install-extension ../dist/regain-1.1.6.vsix


Project preparation creates only the initial capability map and reuses a saved map when available. The overview shows connected project blocks: solid lines show containment, dashed lines show related capabilities. Select a block to explore its children or create a notebook for that scope. Showing saved children and viewing the map do not start AI analysis.

Every agent call is sized to the project. ReGain counts the source files and lines first (archive-style folders apart) and tells the agent how many subjects, children and notebook sections fit, and how many tool steps to aim for; Claude Code is also stopped at a hard step cap. Each subject has a kind: **code** pages trace the code, **experiment** pages give question, setup, result and caveats, and **status** pages say what is done and open, without code. A notebook covers its own subject only; parts with their own pages are named, not absorbed. Long files appear as short excerpts or links, never whole.

While an agent works, its steps appear live in the progress notification and in the **ReGain** output panel: what it is checking, which files it reads, what it searches for, with elapsed time. Each call's duration, steps and cost are appended to `.regain/agent-runs.jsonl`.

**Talk it through (1.2).** Under the map, a conversation helps you settle the main subjects. When a new map is ready, the guide explains the project in simple terms and offers the subjects it would introduce. Ask anything, or say what to merge, split, rename, add or drop: changes you ask for are applied at once, changes the guide only suggests wait for Apply or Skip. Beside the chat, "What ReGain thinks you know" keeps three short lists (you know, you care about, still open) that you can correct in the chat. Notebooks read these lists. The conversation lives in `.regain/conversation.json` and `.regain/learner.json`.

**Guided notebooks.** "Guide me through this" writes the whole notebook at once: the verdict under the title, the words you may not recall, sections in reading order each with its takeaway, the key lines named by what they do, and the open questions at the end. One agent writes it, ReGain checks the hard rules (lengths, headings, line ranges, nothing shown twice, numbers found in the cited files), a second agent reviews it against a rubric and improves it, and a last call fixes any rule still broken. How the page was made (draft, checks, scores, fixes) is kept in `.regain/capability-<id>.guide.json`. To test the generator outside VS Code: `node scripts/guide-eval.js <project> <subject-id> --judge`.

**Beside every block (1.5).** Two tabs sit to the right of each file and code block. The first opens its visual: "Draw a visual" has ReGain's agent read those lines and draw the idea in them (the flow, what goes in and out, real sizes, thresholds and results), checks the SVG is safe, saves it in `.regain/visuals/` and links it to the block. A drawing takes about two minutes. The second opens comments: write what the block should do or how it should change, mark comments done, and "Copy for the agent" turns the open ones into a change request with the block's context. Comments are kept in `<page>.comments.json` beside the page.

**Knowing what was read (1.2).** Before the map is built, ReGain indexes every file without AI (what it defines, what it imports, whether it is an entry point) and gives the index to the agent. While the agent works, ReGain records which files it opened, and the overview says how many of the code files it read and lists the rest. Agent calls run isolated from your own Claude Code plugins, hooks and skills, which keeps them faster and cheaper.

**1.3: reading every file, and an overview that explains.** Before the map is built, every text file in the project is read: code, configs, job scripts, notebooks (without their outputs), results, archived work and docs. Readers run in parallel batches with each file's text in the prompt, and each file's note is cached by its contents in `.regain/file-notes.json`, so a rebuild rereads only changed files. Docs are treated as claims to check against the code. The map, the guide and the notebooks all work from these notes.

The overview now opens with the project in three lines (asks, done so far, next), then the subjects as numbered boxes in reading order, joined by arrows along the main flow, with context subjects above and below. Each subject and step shows where it stands (done, in progress, not started, unknown). "Start here" marks the next subject to read, and "I've got this" ticks a subject off (kept in `.regain/progress.json`). Open questions the files cannot settle are shown up front, and you can answer them in the chat: facts you give are kept and every later prompt hears them. Words a returning developer may not recall get hover explanations on the page and in notebooks. Actions are named by what you get and show the usual time, taken from past runs. On narrow editors the guide becomes a drawer along the bottom.
