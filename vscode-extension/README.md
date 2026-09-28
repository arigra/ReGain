# ReGain for VS Code

Clicking any `.regain/*.html` file opens it as an interactive page instead of source.
File links in the page (relative paths, optional `#L<line>`) open in the editor.

Build and install:

    npx @vscode/vsce package --allow-missing-repository
    code --install-extension regain-0.0.1.vsix

To see the HTML source instead: right-click the file → Open With… → Text Editor.
