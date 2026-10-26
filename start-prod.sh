#!/bin/sh
set -e

echo "🚀 Démarrage de DocForge AI en production..."

# Lancer M1
node modules/m1-ingestion/src/index.js &
echo "  M1 Ingestion démarré (port 3001)"

# Lancer M2
node modules/m2-semantic-analysis/src/index.js &
echo "  M2 Analyse démarré (port 3002)"

# Lancer M3
node modules/m3-reformulation/src/index.js &
echo "  M3 Reformulation démarré (port 3003)"

# Lancer M4
node modules/m4-design/src/index.js &
echo "  M4 Design démarré (port 3004)"

# Lancer M5
node modules/m5-office-generation/src/index.js &
echo "  M5 Génération démarré (port 3005)"

# Attendre que les ports soient prêts
sleep 3

# Lancer M0 (orchestrateur) — en dernier car il dépend des autres
node modules/m0-orchestrator/src/index.js &
echo "  M0 Orchestrateur démarré (port 3000)"

# Attendre encore un peu
sleep 2

echo "✅ Tous les modules démarrés. Lancement de Caddy sur le port $PORT..."
echo "   → Application accessible sur https://<ton-app>.onrender.com"

# Lancer Caddy au premier plan (garde le conteneur en vie)
exec caddy run --config ./Caddyfile --adapter caddyfile