#!/usr/bin/env bash
# Test d'isolation : démarre un module seul, vérifie /health, arrête.
set -e
MODULE=${1:-m1-ingestion}
PORT=${2:-3001}
cd "modules/$MODULE"
node src/index.js &
PID=$!
sleep 2
curl -f "http://localhost:$PORT/health" || (kill $PID; exit 1)
kill $PID
echo "✅ Isolation OK : $MODULE"
