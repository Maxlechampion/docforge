#!/usr/bin/env bash
# Crée un nouveau module isolé avec tests vides.
set -e
NAME=${1:?Usage: new-module.sh <nom-module>}
mkdir -p "modules/$NAME/src" "modules/$NAME/tests"
echo '{ "name": "@docforge/'"$NAME"'", "type": "module", "main": "src/index.js" }' > "modules/$NAME/package.json"
echo "// TODO: implémenter $NAME" > "modules/$NAME/src/index.js"
echo "import { test } from 'node:test';" > "modules/$NAME/tests/smoke.test.js"
echo "✅ Module $NAME créé."
