# ReGain setup for Windows: installs the VS Code extension and the /regain
# skill for Claude Code, then checks that Python can run a kernel.
# Easiest: double-click setup.cmd (it runs this file).
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Step($name) { Write-Host "`n== $name" -ForegroundColor Cyan }

Step "VS Code"
$code = $null
$cmd = Get-Command code -ErrorAction SilentlyContinue
if ($cmd) { $code = $cmd.Source }
foreach ($c in @("$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd",
                 "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd",
                 "${env:ProgramFiles(x86)}\Microsoft VS Code\bin\code.cmd")) {
  if (-not $code -and (Test-Path $c)) { $code = $c }
}
if (-not $code) {
  Write-Host "VS Code was not found. Install it from https://code.visualstudio.com and run this again." -ForegroundColor Red
  exit 1
}
Write-Host "using $code"

Step "Extensions"
$vsix = Get-ChildItem (Join-Path $here "dist\regain-*.vsix") | Sort-Object { [version]($_.BaseName -replace '^regain-', '') } | Select-Object -Last 1
& $code --install-extension $vsix.FullName --force
& $code --install-extension ms-python.python
& $code --install-extension anthropic.claude-code

Step "Claude Code skill /regain"
$skills = Join-Path $env:USERPROFILE ".claude\skills"
New-Item -ItemType Directory -Force -Path $skills | Out-Null
$link = Join-Path $skills "regain"
if (Test-Path $link) {
  $item = Get-Item $link -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    # an old link: remove the link only, never what it points to
    cmd /c rmdir "$link" | Out-Null
  } else {
    $backup = "$link.backup-" + (Get-Date -Format "yyyyMMddHHmmss")
    Rename-Item $link $backup
    Write-Host "an existing $link was moved to $backup"
  }
}
# A junction needs no admin rights and follows updates to the repo.
New-Item -ItemType Junction -Path $link -Target (Join-Path $here "skills\regain") | Out-Null
Write-Host "linked $link -> $here\skills\regain"

Step "Python"
$py = $null
foreach ($name in @("python", "py")) {
  $c = Get-Command $name -ErrorAction SilentlyContinue
  # skip the Microsoft Store stub, which only opens the Store
  if (-not $py -and $c -and $c.Source -notlike "*WindowsApps*") { $py = $c.Source }
}
if (-not $py) {
  Write-Host "No Python found. Install Python 3 from https://python.org (tick 'Add to PATH') or Anaconda, then run this again." -ForegroundColor Red
  exit 1
}
& $py -c "import ipykernel, jupyter_client" 2>$null
if ($LASTEXITCODE -eq 0) {
  Write-Host "$py can run a kernel."
} else {
  Write-Host "$py is missing ipykernel / jupyter_client."
  $yn = Read-Host "Install them with pip now? [Y/n]"
  if ($yn -notmatch '^[nN]') { & $py -m pip install --user ipykernel jupyter_client }
}
Write-Host "Each project may use its own Python: pick it with the kernel button at the top right"
Write-Host "of a ReGain page. That Python needs ipykernel and jupyter_client too."

Step "Done"
Write-Host "Restart VS Code, open a project that has a .regain folder, and click a .regain.md file."
