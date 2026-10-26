#!/bin/sh
set -e

echo "🚀 Démarrage de DocForge AI en production..."

# IMPORTANT : on force les ports internes, on ignore PORT=10000 de Render
# Seul Caddy utilisera le port 10000 fourni par Render

PORT=3001 node modules/m1-ingestion/src/index.js &
echo "  M1 Ingestion démarré (port 3001)"

PORT=3002 node modules/m2-semantic-analysis/src/index.js &
echo "  M2 Analyse démarré (port 3002)"

PORT=3003 node modules/m3-reformulation/src/index.js &
echo "  M3 Reformulation démarré (port 3003)"

PORT=3004 node modules/m4-design/src/index.js &
echo "  M4 Design démarré (port 3004)"

PORT=3005 node modules/m5-office-generation/src/index.js &
echo "  M5 Génération démarré (port 3005)"

sleep 3

PORT=3000 node modules/m0-orchestrator/src/index.js &
echo "  M0 Orchestrateur démarré (port 3000)"

sleep 2

echo "✅ Tous les modules démarrés. Lancement de Caddy sur le port ${PORT}..."

# Caddy utilise le port fourni par Render (10000)
exec caddy run --config ./Caddyfile --adapter caddyfile