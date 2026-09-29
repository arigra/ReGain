# ReGain line explanations for another Python project

ReGain's VS Code extension reads a project-local `.regain/line-importance.json`.
The extension draws line colors and shows short explanations on hover. The
portable generator makes an initial map from Python syntax; an agent then
reads the project and corrects the meanings. No phone-use code or names are
required by this workflow.

The colors follow traffic lights: **red** is critical, **yellow** is
important, and **green** can be skipped on a first reading. Green code may
still be required when running the project.

## Set up a project

1. Install ReGain from this repository with `setup.cmd` on Windows or
   `bash setup.sh` on macOS/Linux. Copy `tools/build_general_importance.py`
   into the other project's `.regain/tooling/`.
   Python 3.9 or newer and the standard library are enough for the generator.
2. Ask an engineering agent to read the project first, identify its main
   flow, and create a `.regain/*.regain.md` notebook. Have it link the files
   that explain that flow, in reading order, and add runnable Python fences
   when useful. It should record uncertain or external behavior explicitly.
   For example:

   ````markdown
   # My project

   ```file src/core.py
   ```

   ```python
   from src.core import calculate
   calculate(3)
   ```
   ````

   File paths are relative to the project root. Each file block refers to the
   complete file; the source stays in its normal location.
3. From the project root, run:

   ```shell
   python .regain/tooling/build_general_importance.py
   ```

   This writes `.regain/line-importance.json` and
   `.regain/importance-agent-review.md`. The first map is a **draft**. Its
   low-confidence hover text says so.
4. Ask an engineering agent to follow `.regain/importance-agent-review.md`.
   Give it access to the whole project and time to inspect call sites and
   documents. It should write corrections to
   `.regain/importance-reviews.json`, with exact source hashes and a unique
   line match. Run the generator again to apply the reviews. Use
   `python .regain/tooling/build_general_importance.py --require-reviewed`
   when preparing a shared map; it fails while important or critical lines
   still have draft explanations or reviews are stale.
5. Open the notebook in VS Code. ReGain reloads the map when it changes.
   Rebuild and review after editing code; source hashes stop stale
   explanations from being shown.

## What transfers, and what needs an agent

The extension, JSON format, Python syntax pass, and review workflow work
across projects. Syntax can identify conditions, returns, calculations, and
display calls, but it cannot establish product importance. For example, an
`if` may be a decision gate or only control a progress message. The agent
must trace that line's effect and write the specific explanation. An agent
can still be uncertain; it should say so instead of inventing a reason.

The generator handles Python file blocks and `python` cells, plus draft
line explanations for YAML, JSON, TOML, CFG, and INI file blocks. For ranged
file blocks, only visible lines count toward the review requirement, although
the agent should read the full file for context. Other languages need a parser
or agent-authored map. ReGain
does not yet launch an agent automatically; the generated review document is
the handoff that works with any engineering agent.

If the project already has a map from a different generator, the portable
generator leaves it untouched. Pass `--replace-existing` only when you intend
to replace those existing explanations.

## Map and review format

The generated map has `files` keyed by project-relative path and `cells`
keyed by the cell's SHA-256. Each plan has aligned `lines`, `reasons`, and
`confidence` arrays plus a `sha256` for its source. ReGain accepts this map
without project-specific extension changes.

An agent correction has this shape:

```json
[
  {
    "file": "src/core.py",
    "sha256": "the current file hash printed in importance-agent-review.md",
    "match": "if ready and score >= threshold:",
    "importance": "critical",
    "why": "This gate prevents publishing a result until readiness and score both pass."
  }
]
```

For a runnable cell, replace `file` with `cell_sha256`. A changed source hash
or ambiguous match is reported as `Review needed`; the correction is not
silently applied.
If the same match occurs more than once, add a one-based `line` number.
