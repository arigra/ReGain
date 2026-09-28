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

To see either file as text: right-click → Open With… → Text Editor.

Build, test, install:

    npm install
    REGAIN_PYTHON=python3 npm test
    npx @vscode/vsce package --allow-missing-repository --skip-license
    code --install-extension regain-0.2.4.vsix
