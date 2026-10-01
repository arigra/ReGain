"""Package the ReGain extension using the previous VSIX when Node is unavailable.

Normal releases should use ``npm run package`` in vscode-extension. This
fallback preserves the previous VSIX metadata and overlays current source.
"""

from pathlib import Path
import json
import re
import zipfile


ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "vscode-extension"
VERSION = json.loads((EXT / "package.json").read_text(encoding="utf-8"))["version"]
OUTPUT = ROOT / "dist" / f"regain-{VERSION}.vsix"
OLDER = sorted(
    (item for item in (ROOT / "dist").glob("regain-*.vsix") if item != OUTPUT),
    key=lambda item: tuple(int(part) for part in item.stem.removeprefix("regain-").split(".")),
)
if not OLDER:
    raise RuntimeError("An earlier ReGain VSIX is needed as the metadata template")
PREVIOUS = OLDER[-1]

overlays = {
    "extension/resources/tooling/build_general_importance.py": ROOT / "tools" / "build_general_importance.py",
    "extension/resources/tooling/cpp_importance.py": ROOT / "tools" / "cpp_importance.py",
}
for source in EXT.rglob("*"):
    if not source.is_file() or any(part in {"test", "node_modules", "scripts", "resources"} for part in source.relative_to(EXT).parts):
        continue
    if source.name == "package.json":
        overlays["extension/package.json"] = source
    elif source.name == "README.md":
        overlays["extension/readme.md"] = source
    elif source.suffix in {".js", ".py", ".css", ".svg"}:
        overlays["extension/" + source.relative_to(EXT).as_posix()] = source

with zipfile.ZipFile(PREVIOUS) as old, zipfile.ZipFile(OUTPUT, "w", zipfile.ZIP_DEFLATED) as new:
    for entry in old.infolist():
        if entry.filename in overlays:
            continue
        content = old.read(entry.filename)
        if entry.filename == "extension.vsixmanifest":
            manifest = content.decode("utf-8")
            manifest, count = re.subn(r'(<Identity[^>]*\bVersion=")[^"]+', rf'\g<1>{VERSION}', manifest, count=1)
            if count != 1:
                raise RuntimeError("Could not update VSIX version")
            content = manifest.encode("utf-8")
        elif entry.filename == "[Content_Types].xml":
            content = content.replace(b"</Types>", b'<Default Extension=".svg" ContentType="image/svg+xml"/></Types>')
        new.writestr(entry, content)
    for name, source in overlays.items():
        new.write(source, name)

print(OUTPUT)
