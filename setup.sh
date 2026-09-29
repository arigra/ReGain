#!/usr/bin/env bash
# ReGain setup for macOS and Linux: installs the VS Code extension and the
# /regain skill for Claude Code, then checks that Python can run a kernel.
# Run from anywhere:  bash setup.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

step() { printf '\n== %s\n' "$1"; }

step "VS Code"
code_cli="$(command -v code || true)"
for c in "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
         "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
         "$HOME/Downloads/Visual Studio Code.app/Contents/Resources/app/bin/code" \
         /usr/share/code/bin/code /snap/bin/code; do
  [ -z "$code_cli" ] && [ -x "$c" ] && code_cli="$c"
done
if [ -z "$code_cli" ]; then
  echo "VS Code was not found. Install it from https://code.visualstudio.com and run this again."
  exit 1
fi
echo "using $code_cli"

step "Extensions"
vsix="$(ls "$here"/dist/regain-*.vsix | sort -V | tail -1)"
"$code_cli" --install-extension "$vsix" --force
"$code_cli" --install-extension ms-python.python
"$code_cli" --install-extension anthropic.claude-code

step "Claude Code skill /regain"
skills="$HOME/.claude/skills"
mkdir -p "$skills"
if [ -e "$skills/regain" ] && [ ! -L "$skills/regain" ]; then
  backup="$skills/regain.backup-$(date +%Y%m%d%H%M%S)"
  mv "$skills/regain" "$backup"
  echo "an existing $skills/regain was moved to $backup"
fi
ln -sfn "$here/skills/regain" "$skills/regain"
echo "linked $skills/regain -> $here/skills/regain"

step "Python"
py="$(command -v python3 || command -v python || true)"
if [ -z "$py" ]; then
  echo "No Python found. Install Python 3 (or Anaconda), then run this again."
  exit 1
fi
if "$py" -c "import ipykernel, jupyter_client" 2>/dev/null; then
  echo "$py can run a kernel."
else
  echo "$py is missing ipykernel / jupyter_client."
  if ! read -r -p "Install them with pip now? [Y/n] " yn; then
    yn=n
    echo "(no answer: skipped; install later with: $py -m pip install ipykernel jupyter_client)"
  fi
  if [ "${yn:-Y}" != "n" ] && [ "${yn:-Y}" != "N" ]; then
    "$py" -m pip install --user ipykernel jupyter_client
  fi
fi
echo "Each project may use its own Python: pick it with the kernel button at the top right"
echo "of a ReGain page. That Python needs ipykernel and jupyter_client too."

step "Done"
echo "Restart VS Code (or run 'Developer: Reload Window'), open a project that has a .regain/"
echo "folder, and click a .regain.md file."
