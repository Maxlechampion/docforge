# DocForge AI

SaaS B2B francophone (Afrique de l'Ouest) — transforme du contenu brut en documents Word/Excel/PowerPoint/PDF professionnels.

## Contraintes

- **0.1 — Stack 100 % gratuite** : aucun outil payant.
- **0.2 — Architecture modulaire, isolation stricte** : aucun module non fonctionnel n'impacte les autres.

## Arborescence

```
modules/
  m1-ingestion/          # Upload, paste, OCR, parsing
  m2-semantic-analysis/  # Structuration sémantique
  m3-reformulation/      # Reformulation ON/OFF
  m4-design/             # Design & templates
  m5-office-generation/  # Génération .docx/.xlsx/.pptx/.pdf
  m6-credits/            # Crédits & facturation
  m7-auth/               # Auth JWT
  m8-payment/            # Paiement
  m9-monitoring/         # Health, métriques, logs
shared/
  contracts/v1/          # Schémas JSON d'interface
  logger/                # Logger partagé
  circuit-breaker/       # Circuit breaker partagé
  feature-flags/         # Flags à chaud
infra/
  docker-compose.yml     # Postgres + Redis + MinIO + Ollama
  nginx/ prometheus/
.github/workflows/       # CI + isolation + deploy
scripts/                 # Utilitaires
```

## Démarrage rapide

```bash
# 1. Lancer l'infra locale (Postgres, Redis, MinIO, Ollama)
docker compose -f infra/docker-compose.yml up -d

# 2. Lancer un module
cd modules/m1-ingestion
npm install
node src/index.js

# 3. Tests
node --test tests/*.test.js
```

## Ports

| Module | Port |
|---|---|
| M1 Ingestion | 3001 |
| M2 Analyse | 3002 |
| M3 Reformulation | 3003 |
| M4 Design | 3004 |
| M5 Office | 3005 |
| M6 Crédits | 3006 |
| M7 Auth | 3007 |
| M8 Paiement | 3008 |
| M9 Monitoring | 3009 |
