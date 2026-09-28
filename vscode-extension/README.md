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

  The kernel uses `regain.python`, else the interpreter the Python extension selected, else
  `python3`. That Python needs `jupyter_client` and `ipykernel`. Edited files are reloaded
  automatically (`%autoreload 2`).

To see either file as text: right-click → Open With… → Text Editor.

Build, test, install:

    npm install
    REGAIN_PYTHON=python3 npm test
    npx @vscode/vsce package --allow-missing-repository --skip-license
    code --install-extension regain-0.1.0.vsix
