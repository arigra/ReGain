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
  - Red lines from `.regain/bites.json` (`[{"file", "match", "why"}]`, matched by text), with
    the reason under the block. A match that is no longer found is reported.
  - Lines changed since you last looked at a file (by an agent, another editor), until
    "Mark as seen". Your own saves count as seen.
  - Under each code block, the variables its run created or replaced, with type and shape.
  - Outputs are kept in `<page>.regain.outputs.json` next to the page and shown again,
    marked as from an earlier session. Plots (matplotlib) show inline.

To see either file as text: right-click → Open With… → Text Editor.

Build, test, install:

    npm install
    REGAIN_PYTHON=python3 npm test
    npx @vscode/vsce package --allow-missing-repository --skip-license
    code --install-extension regain-0.3.0.vsix
