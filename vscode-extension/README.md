# ReGain for VS Code

Two views, both opened by clicking the file:

- `.regain/*.html`: an interactive page. File links (relative paths, optional `#L<line>`) open in the editor.
- `*.regain.md`: a notebook-style page. Plain markdown text, plus two fences:

      ```file src/train.py          shows the real file; typing edits it on disk
      ```
      ```file src/radial.py 114-127 only those lines
      ```
      ```python                     runs in a Jupyter kernel started in the project root
      from src.train import train
      ```

  ▶ next to a code block runs it; ▶ next to a file block saves the file (typing alone does
  not). Shift+Enter does the same and moves on. Saved files are picked up by the kernel
  without a restart (`%autoreload 2`).

  The kernel button at the top right picks the Python, like Jupyter's "Select Kernel".
  Default: `regain.python`, else the Python extension's interpreter, else `python3`. It
  needs `jupyter_client` and `ipykernel`.

  Also in these pages:
  - Python highlighting in file and code blocks.
  - Red, yellow, and green lines from `.regain/line-importance.json` mark
    critical, important, and first-pass skippable code. Hover for the reason.
    The same colors work in source file blocks and runnable Python blocks.
    `.regain/bites.json` can supply focused explanations with `file`, a unique
    `match`, `why`, and `importance`. The old notes list under file blocks is hidden.
  - Long file blocks grow to a window-relative height before scrolling.
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
    code --install-extension ../dist/regain-0.7.3.vsix
