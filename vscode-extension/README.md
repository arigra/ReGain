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
drafts. Set **ReGain: Analysis Provider** to **Claude Code** to use Claude for
preparation and notebook generation. The Claude Code CLI must be installed and
available on `PATH`, or set **ReGain: Claude Executable** to its absolute path.
The default provider is Codex, available through the Codex VS Code extension or
on `PATH`. Preparing a project sends its source-derived contents to the selected provider.
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
