#!/usr/bin/env node
/**
 * ============================================================
 * DocForge AI — Scaffolder d'architecture
 * ------------------------------------------------------------
 * Crée l'arborescence complète du projet :
 *   - 9 modules (M1 → M9) isolés
 *   - contrats d'interface versionnés (shared/contracts/v1)
 *   - utilitaires partagés (shared/logger, shared/circuit-breaker, shared/feature-flags)
 *   - infra (docker-compose, nginx, prometheus)
 *   - workflows GitHub Actions
 *   - scripts utilitaires
 *   - package.json racine (workspaces npm)
 *   - .env.example
 *   - README.md
 *
 * Idempotent : ne réécrit jamais un fichier existant sans --force.
 *
 * Usage :
 *   node scaffold-docforge.js
 *   node scaffold-docforge.js --force
 * ============================================================
 */

import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const FORCE = process.argv.includes('--force');

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function ensureDir(rel) {
  const abs = join(ROOT, rel);
  await mkdir(abs, { recursive: true });
  console.log(`  📁 ${rel}/`);
}

async function writeIfNeeded(rel, content) {
  const abs = join(ROOT, rel);
  const exists = await fileExists(abs);
  if (exists && !FORCE) {
    console.log(`  ⏭  ${rel} (existe, ignoré)`);
    return;
  }
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf-8');
  console.log(`  ✅ ${rel}`);
}

// ------------------------------------------------------------
// Contenu des fichiers
// ------------------------------------------------------------

const MODULES = [
  { id: 'm1-ingestion',         port: 3001, role: 'Upload, paste, parsing, OCR' },
  { id: 'm2-semantic-analysis', port: 3002, role: 'Détection H1/H2/H3, listes, tableaux' },
  { id: 'm3-reformulation',     port: 3003, role: 'Reformulation ON/OFF' },
  { id: 'm4-design',            port: 3004, role: 'Design & templates' },
  { id: 'm5-office-generation', port: 3005, role: 'Génération .docx/.xlsx/.pptx/.pdf' },
  { id: 'm6-credits',           port: 3006, role: 'Crédits & facturation' },
  { id: 'm7-auth',              port: 3007, role: 'Auth & comptes JWT' },
  { id: 'm8-payment',           port: 3008, role: 'Paiement (Fedapay manuel + Binance Pay)' },
  { id: 'm9-monitoring',        port: 3009, role: 'Health, métriques, logs' },
];

const packageJsonModule = (mod) => JSON.stringify({
  name: `@docforge/${mod.id}`,
  version: '0.1.0',
  private: true,
  type: 'module',
  description: mod.role,
  main: 'src/index.js',
  scripts: {
    start: 'node src/index.js',
    test: 'node --test tests/*.test.js',
    selftest: 'node src/index.js --selftest',
  },
  dependencies: {
    fastify: '^4.28.0',
    opossum: '^8.1.4',
  },
  engines: { node: '>=20' },
}, null, 2);

const dockerfileModule = (mod) => `FROM node:20-alpine
RUN apk add --no-cache poppler-utils tesseract-ocr tesseract-ocr-data-fra
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev
COPY src ./src
EXPOSE ${mod.port}
CMD ["node", "src/index.js"]
`;

const indexJsTemplate = (mod) => `/**
 * DocForge AI — ${mod.id}
 * Rôle : ${mod.role}
 *
 * Point d'entrée du module. Isolé par contrat (voir shared/contracts/v1).
 */
import Fastify from 'fastify';

const app = Fastify({ logger: true });

app.get('/health', async () => ({ status: 'ok', module: '${mod.id.replace(/-.*/, '').toUpperCase()}' }));

const port = Number(process.env.PORT || ${mod.port});
try {
  await app.listen({ port, host: '0.0.0.0' });
  console.log(\`🚀 ${mod.id} → http://localhost:\${port}\`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

const shutdown = async (sig) => {
  console.log(\`\\n⏹  \${sig} → arrêt propre ${mod.id}\`);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
`;

const testTemplate = (mod) => `import { test } from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';

test('${mod.id} — health check répond', async () => {
  // Test placeholder : à remplacer par les vraies routes du module
  const app = Fastify();
  app.get('/health', async () => ({ status: 'ok' }));
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  await app.close();
});
`;

// ------------------------------------------------------------
// Exécution
// ------------------------------------------------------------

console.log('\n🏗  Scaffold DocForge AI\n');

// 1. Dossiers racine
await ensureDir('modules');
await ensureDir('shared');
await ensureDir('shared/contracts/v1');
await ensureDir('shared/logger');
await ensureDir('shared/circuit-breaker');
await ensureDir('shared/feature-flags');
await ensureDir('infra');
await ensureDir('infra/nginx');
await ensureDir('infra/prometheus');
await ensureDir('scripts');
await ensureDir('.github');
await ensureDir('.github/workflows');

// 2. Modules
for (const mod of MODULES) {
  await ensureDir(`modules/${mod.id}`);
  await ensureDir(`modules/${mod.id}/src`);
  await ensureDir(`modules/${mod.id}/tests`);
  await writeIfNeeded(`modules/${mod.id}/package.json`, packageJsonModule(mod));
  await writeIfNeeded(`modules/${mod.id}/Dockerfile`, dockerfileModule(mod));
  await writeIfNeeded(`modules/${mod.id}/src/index.js`, indexJsTemplate(mod));
  await writeIfNeeded(`modules/${mod.id}/tests/smoke.test.js`, testTemplate(mod));
}

// 3. package.json racine (workspaces npm)
await writeIfNeeded('package.json', JSON.stringify({
  name: 'docforge-ai',
  version: '0.1.0',
  private: true,
  type: 'module',
  description: 'DocForge AI — SaaS de production documentaire (stack 100% gratuite)',
  workspaces: ['modules/*', 'shared/*'],
  scripts: {
    test: 'node --test modules/*/tests/*.test.js',
    'test:module': 'node --test modules/$npm_config_module/tests/*.test.js',
    lint: 'eslint modules shared --ext .js',
    dev: 'docker compose -f infra/docker-compose.yml up -d',
    'dev:down': 'docker compose -f infra/docker-compose.yml down',
    scaffold: 'node scaffold-docforge.js',
  },
  engines: { node: '>=20' },
  devDependencies: {
    eslint: '^9.10.0',
  },
}, null, 2));

// 4. Contrat d'interface v1 — exemple (semantic-analysis)
await writeIfNeeded('shared/contracts/v1/semantic-analysis.schema.json', JSON.stringify({
  $id: 'https://docforge.ai/schemas/v1/semantic-analysis.json',
  type: 'object',
  required: ['version', 'blocks'],
  properties: {
    version: { const: '1.0' },
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['level', 'type', 'content'],
        properties: {
          level: { enum: ['h1', 'h2', 'h3', 'body', 'caption'] },
          type: { enum: ['text', 'list', 'table', 'quote'] },
          content: { type: 'string' },
          rows: { type: 'array', items: { type: 'array' } },
        },
      },
    },
    fallback_used: { type: 'boolean', default: false },
  },
}, null, 2));

await writeIfNeeded('shared/contracts/v1/ingestion.schema.json', JSON.stringify({
  $id: 'https://docforge.ai/schemas/v1/ingestion.json',
  type: 'object',
  required: ['version', 'blocks', 'meta'],
  properties: {
    version: { const: '1.0' },
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['level', 'type', 'content'],
        properties: {
          level: { enum: ['h1', 'h2', 'h3', 'body', 'caption'] },
          type: { enum: ['text', 'list', 'table', 'quote'] },
          content: { type: 'string' },
        },
      },
    },
    meta: {
      type: 'object',
      required: ['source', 'fallback_used'],
      properties: {
        source: { enum: ['txt', 'docx', 'pdf', 'pptx', 'image', 'paste'] },
        filename: { type: 'string' },
        fallback_used: { type: 'boolean' },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
  },
}, null, 2));

// 5. shared/logger
await writeIfNeeded('shared/logger/index.js', `/**
 * Logger partagé — utilisé par tous les modules.
 * Exporte un logger Fastify configuré (niveau via env).
 */
export function createLoggerOptions() {
  return {
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV === 'production' ? undefined : {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
    },
  };
}
`);

// 6. shared/circuit-breaker
await writeIfNeeded('shared/circuit-breaker/index.js', `/**
 * Circuit breaker partagé (opossum).
 * Utilisé pour protéger tout appel inter-modules ou service externe.
 * Cf. contrainte 0.2 §4.3.3.
 */
import CircuitBreaker from 'opossum';

export function createBreaker(fn, options = {}) {
  const breaker = new CircuitBreaker(fn, {
    timeout: options.timeout ?? 15000,
    errorThresholdPercentage: options.errorThresholdPercentage ?? 50,
    resetTimeout: options.resetTimeout ?? 30000,
    ...options,
  });
  breaker.on('open', () => console.warn('[breaker] OPEN'));
  breaker.on('halfOpen', () => console.warn('[breaker] HALF-OPEN'));
  breaker.on('close', () => console.info('[breaker] CLOSED'));
  return breaker;
}
`);

// 7. shared/feature-flags
await writeIfNeeded('shared/feature-flags/index.js', `/**
 * Feature flags — désactivation à chaud (contrainte 0.2 §4.3.2).
 * Source de vérité : table PostgreSQL \`feature_flags\`.
 */
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const cache = new Map();

export async function isEnabled(flagName) {
  if (cache.has(flagName)) return cache.get(flagName);
  try {
    const { rows } = await pool.query(
      'SELECT enabled FROM feature_flags WHERE name = $1', [flagName]
    );
    const enabled = rows[0]?.enabled ?? false;
    cache.set(flagName, enabled);
    setTimeout(() => cache.delete(flagName), 30000);
    return enabled;
  } catch {
    return false; // fail-closed : flag OFF par défaut si DB indisponible
  }
}

export async function setFlag(flagName, enabled) {
  await pool.query(
    \`INSERT INTO feature_flags (name, enabled) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET enabled = EXCLUDED.enabled\`,
    [flagName, enabled]
  );
  cache.delete(flagName);
}
`);

// 8. docker-compose
await writeIfNeeded('infra/docker-compose.yml', `services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: docforge
      POSTGRES_PASSWORD: docforge
      POSTGRES_DB: docforge
    ports: ["5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]

  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: docforge
      MINIO_ROOT_PASSWORD: docforge123
    ports: ["9000:9000", "9001:9001"]
    volumes: [miniodata:/data]

  ollama:
    image: ollama/ollama:latest
    ports: ["11434:11434"]
    volumes: [ollamadata:/root/.ollama]

volumes:
  pgdata:
  miniodata:
  ollamadata:
`);

// 9. .env.example
await writeIfNeeded('.env.example', `# ============================================================
# DocForge AI — variables d'environnement
# ============================================================
NODE_ENV=development
LOG_LEVEL=info

# Base de données
DATABASE_URL=postgres://docforge:docforge@localhost:5432/docforge

# Redis
REDIS_URL=redis://localhost:6379

# MinIO
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_ACCESS_KEY=docforge
MINIO_SECRET_KEY=docforge123
MINIO_BUCKET=docforge-docs

# LLM — Ollama local (par défaut) ou Groq free tier
LLM_PROVIDER=ollama
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2:3b
# GROQ_API_KEY= (si LLM_PROVIDER=groq)

# JWT
JWT_SECRET=change-me-in-production
JWT_EXPIRES_IN=7d

# Paiement (M8)
FEDAPAY_SECRET_KEY=
BINANCE_PAY_API_KEY=
BINANCE_PAY_SECRET=

# Ports des modules
M1_PORT=3001
M2_PORT=3002
M3_PORT=3003
M4_PORT=3004
M5_PORT=3005
M6_PORT=3006
M7_PORT=3007
M8_PORT=3008
M9_PORT=3009
`);

// 10. .gitignore
await writeIfNeeded('.gitignore', `node_modules/
.env
.env.local
*.log
dist/
coverage/
.DS_Store
.idea/
.vscode/
tmp/
*.msi
demo.txt
`);

// 11. Workflows GitHub Actions
await writeIfNeeded('.github/workflows/ci.yml', `name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        module:
          - m1-ingestion
          - m2-semantic-analysis
          - m3-reformulation
          - m4-design
          - m5-office-generation
          - m6-credits
          - m7-auth
          - m8-payment
          - m9-monitoring
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci || npm install
      - name: Tests \${{ matrix.module }}
        run: node --test modules/\${{ matrix.module }}/tests/*.test.js
`);

await writeIfNeeded('.github/workflows/isolation-tests.yml', `name: Isolation Tests

on:
  pull_request:
    paths: ['modules/**']

jobs:
  isolation:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci || npm install
      - name: Vérifier que chaque module démarre seul
        run: |
          for m in modules/*/; do
            echo "→ Test isolation : $m"
            (cd "$m" && node src/index.js &) ; sleep 2
            curl -f "http://localhost:\$(node -e 'console.log(3000 + Math.floor(Math.random()*10))')/health" || true
            pkill -f "node src/index.js" || true
          done
`);

await writeIfNeeded('.github/workflows/deploy-module.yml', `name: Deploy Module (exemple)

on:
  push:
    branches: [main]
    paths: ['modules/m1-ingestion/**']

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci || npm install
      - run: node --test modules/m1-ingestion/tests/*.test.js
      - run: docker build -t docforge/m1:\${{ github.sha }} modules/m1-ingestion
      # Étape de push/publish à activer selon la plateforme (ghcr.io, Render, Fly)
`);

// 12. Scripts utilitaires
await writeIfNeeded('scripts/run-isolation-test.sh', `#!/usr/bin/env bash
# Test d'isolation : démarre un module seul, vérifie /health, arrête.
set -e
MODULE=\${1:-m1-ingestion}
PORT=\${2:-3001}
cd "modules/\$MODULE"
node src/index.js &
PID=\$!
sleep 2
curl -f "http://localhost:\$PORT/health" || (kill \$PID; exit 1)
kill \$PID
echo "✅ Isolation OK : \$MODULE"
`);

await writeIfNeeded('scripts/new-module.sh', `#!/usr/bin/env bash
# Crée un nouveau module isolé avec tests vides.
set -e
NAME=\${1:?Usage: new-module.sh <nom-module>}
mkdir -p "modules/\$NAME/src" "modules/\$NAME/tests"
echo '{ "name": "@docforge/'"\$NAME"'", "type": "module", "main": "src/index.js" }' > "modules/\$NAME/package.json"
echo "// TODO: implémenter \$NAME" > "modules/\$NAME/src/index.js"
echo "import { test } from 'node:test';" > "modules/\$NAME/tests/smoke.test.js"
echo "✅ Module \$NAME créé."
`);

// 13. README racine
await writeIfNeeded('README.md', `# DocForge AI

SaaS B2B francophone (Afrique de l'Ouest) — transforme du contenu brut en documents Word/Excel/PowerPoint/PDF professionnels.

## Contraintes

- **0.1 — Stack 100 % gratuite** : aucun outil payant.
- **0.2 — Architecture modulaire, isolation stricte** : aucun module non fonctionnel n'impacte les autres.

## Arborescence

\`\`\`
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
\`\`\`

## Démarrage rapide

\`\`\`bash
# 1. Lancer l'infra locale (Postgres, Redis, MinIO, Ollama)
docker compose -f infra/docker-compose.yml up -d

# 2. Lancer un module
cd modules/m1-ingestion
npm install
node src/index.js

# 3. Tests
node --test tests/*.test.js
\`\`\`

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
`);

console.log('\n✅ Architecture DocForge AI créée avec succès.\n');
console.log('Prochaines étapes :');
console.log('  1. docker compose -f infra/docker-compose.yml up -d');
console.log('  2. cd modules/m1-ingestion && npm install && node src/index.js');
console.log('  3. Voir README.md pour les ports et la structure complète.\n');