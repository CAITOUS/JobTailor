#!/usr/bin/env bash
# Builds the release package: dist/JobTailor-<version>.zip
# The zip holds one folder, JobTailor/, with only the files the browser needs.
# Usage: scripts/package.sh   (run from anywhere)
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
OUT="dist/JobTailor-${VERSION}.zip"
STAGE=$(mktemp -d)
mkdir -p "$STAGE/JobTailor" dist
cp manifest.json background.js panel.html panel.js panel.css options.html options.js LICENSE "$STAGE/JobTailor/"
cp -r lib icons "$STAGE/JobTailor/"
cat > "$STAGE/JobTailor/INSTALL.txt" <<TXT
Job Tailor ${VERSION}

NEW INSTALL
1. Move this JobTailor folder somewhere permanent (for example Documents/JobTailor).
   The browser runs the extension from this folder, so don't move or delete it later.
2. Open your extensions page: brave://extensions, chrome://extensions or edge://extensions
3. Turn on Developer mode (top-right in Brave and Chrome; left-hand menu in Edge).
4. Click "Load unpacked" and choose this JobTailor folder (the one with manifest.json in it).
5. Pin Job Tailor to your toolbar. Options opens so you can add your API key, details and career files.

UPDATING FROM AN EARLIER VERSION
1. Back up first: Options > Download backup.
2. Replace the files in your existing JobTailor folder with these files.
3. On your extensions page, click Reload on the Job Tailor card. Your data carries over.
   Never click Remove to update: it deletes your settings, context and log.

User manual: https://github.com/CAITOUS/JobTailor/blob/main/docs/MANUAL.md
What's new:  https://github.com/CAITOUS/JobTailor/blob/main/CHANGELOG.md
TXT
rm -f "$OUT"
(cd "$STAGE" && zip -qrX "$OLDPWD/$OUT" JobTailor)
rm -rf "$STAGE"
echo "$OUT"
