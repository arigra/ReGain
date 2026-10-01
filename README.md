# ReGain

ReGain helps you get back into a project that AI agents built, when you know what it is for but no longer know what is inside. It lives in VS Code, next to a Claude Code chat:

- **An overview page**: the project in one picture, with its parts and the files they live in.
- **Notebook pages** (`*.regain.md`): the project's real files, in the order they run, each followed by a short piece of code that runs it. Red lines mark critical decisions, yellow lines mark important calculations, and green lines can be skipped on a first reading. Hover for a short reason. Lines changed since you last looked have a separate purple marker. Each block can carry a picture that explains it.
- **The `/regain` guide** in Claude Code: answers questions about the project at the level you are at, from what `.regain/understanding.md` and the code say.

A project's ReGain files live in its own `.regain/` folder, so they travel with the project in git.

## Install

You need [VS Code](https://code.visualstudio.com), [git](https://git-scm.com), and Python 3 (from [python.org](https://www.python.org) with "Add to PATH" ticked, or [Anaconda](https://www.anaconda.com)). Claude Code is installed by the setup.

```
git clone https://github.com/arigra/ReGain.git
```

**Windows**: open the `ReGain` folder and double-click `setup.cmd`.

**macOS / Linux**: `bash ReGain/setup.sh`

The setup installs the ReGain, Python and Claude Code extensions into VS Code, links the `/regain` skill into Claude Code, and checks that your Python has `ipykernel` and `jupyter_client` (it offers to install them). Then restart VS Code.

## Use it on a project

1. Click the **ReGain** icon in the VS Code Activity Bar. Choose **Prepare current project** or **Choose a project folder**. Codex traces the selected project in read-only mode, and ReGain turns the result into a capability diagram in `.regain/overview.html`. Select a capability for a second, detailed analysis, source walkthrough, and reviewed line reasons.
2. Click `.regain/overview.html` for the big picture, or a `.regain/*.regain.md` page for the file-by-file view.
3. On a notebook page, pick the Python with the kernel button at the top right (it needs the project's packages, plus `ipykernel` and `jupyter_client`), then press **▶ Run all**.
4. Open Claude Code in the side window and type `/regain` to talk about the project.

The sidebar's **Create an empty folder** action opens a new empty workspace. Add code before preparing its walkthrough. The included `.regain/tooling/build_general_importance.py` can create draft line highlighting; review its explanations as described in [the line importance guide](docs/line-importance.md).

In a notebook page, ▶ next to a code block runs it, ▶ next to a file block saves the file, and the ▸ on the right of a block opens its pictures.

File blocks grow with their contents up to a window-relative height, then scroll.
See [line importance in other projects](docs/line-importance.md) for the Python
and C++ generator and agent review workflow. Its first pass is a draft; the agent
must trace project behavior to give reliable explanations.

## If something does not work

- **The kernel does not start**: a red bar at the top of the page says why. Usually the chosen Python lacks `ipykernel` / `jupyter_client`: install them into that Python (`python -m pip install ipykernel jupyter_client`) or pick another one.
- **Windows says "python was not found" or opens the Microsoft Store**: that is Windows' placeholder, not Python. Install Python from python.org with "Add to PATH" ticked.
- **A page opens as plain text**: right-click it → Open With… → ReGain notebook (or ReGain page).

## For development

The extension is in `vscode-extension/`. `npm install`, then `npm test` (set `REGAIN_PYTHON` to a Python with `ipykernel`), and `npm run package` writes a new `dist/regain-<version>.vsix`. The tests run on Windows, macOS and Linux on every push.
