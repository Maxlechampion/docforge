#!/usr/bin/env node
/**
 * start-all.js — Lance les 5 modules DocForge AI en parallèle
 */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { execSync } from 'node:child_process';

/**
 * Tue les processus qui occupent les ports des modules avant démarrage.
 * Windows : netstat -ano + taskkill. Unix : lsof -ti + kill.
 */
async function killOrphans(ports) {
  console.log(`\n\x1b[33m🔍 Nettoyage des orphelins sur ports : ${ports.join(', ')}\x1b[0m`);
  for (const port of ports) {
    try {
      if (process.platform === 'win32') {
        const output = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (output) {
          const pids = [...new Set(output.split('\n').map((l) => l.trim().split(/\s+/).pop()))];
          for (const pid of pids) {
            if (pid && pid !== '0') {
              try {
                execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
                console.log(`  \x1b[90m→ PID ${pid} tué (port ${port})\x1b[0m`);
              } catch {}
            }
          }
        }
      } else {
        try {
          const pid = execSync(`lsof -ti :${port}`, { encoding: 'utf-8' }).trim();
          if (pid) {
            execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
            console.log(`  \x1b[90m→ PID ${pid} tué (port ${port})\x1b[0m`);
          }
        } catch {}
      }
    } catch {}
  }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const MODULES = [
  { id: 'M0', name: 'Orchestrateur', port: 3000, dir: 'm0-orchestrator' },
  { id: 'M1', name: 'Ingestion',     port: 3001, dir: 'm1-ingestion' },
  { id: 'M2', name: 'Analyse',       port: 3002, dir: 'm2-semantic-analysis' },
  { id: 'M3', name: 'Reformulation', port: 3003, dir: 'm3-reformulation' },
  { id: 'M4', name: 'Design',        port: 3004, dir: 'm4-design' },
  { id: 'M5', name: 'Génération',    port: 3005, dir: 'm5-office-generation' },
  { id: 'M6', name: 'Crédits',       port: 3006, dir: 'm6-credits' },
  { id: 'M7', name: 'Auth',          port: 3007, dir: 'm7-auth' },
  { id: 'M8', name: 'Paiement',      port: 3008, dir: 'm8-payment' },
  { id: 'M9', name: 'Monitoring',    port: 3009, dir: 'm9-monitoring' },
];

const args = process.argv.slice(2);
const USE_ALL = args.includes('--all');
const SKIP = args.filter((a) => a.startsWith('--skip='))
  .flatMap((a) => a.replace('--skip=', '').split(','))
  .map((s) => s.trim().toUpperCase());

const modulesToRun = USE_ALL ? MODULES : MODULES.slice(0, 6); // M0→M5
if (SKIP.length > 0) modulesToRun = modulesToRun.filter((m) => !SKIP.includes(m.id));

const C = { reset:'\x1b[0m', dim:'\x1b[2m', bold:'\x1b[1m', red:'\x1b[31m', green:'\x1b[32m', yellow:'\x1b[33m', blue:'\x1b[34m', magenta:'\x1b[35m', cyan:'\x1b[36m', white:'\x1b[37m' };
const MODULE_COLORS = { M1:C.cyan, M2:C.green, M3:C.yellow, M4:C.magenta, M5:C.blue, M6:C.cyan, M7:C.green, M8:C.yellow, M9:C.magenta };

function prefix(mod, line) {
  return `${MODULE_COLORS[mod.id] || C.white}[${mod.id}]${C.reset} ${line}`;
}
function ts() { return new Date().toLocaleTimeString('fr-FR', { hour12: false }); }

function isPortOpen(port, timeout = 500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (r) => { if (done) return; done = true; socket.destroy(); resolve(r); };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, '127.0.0.1');
  });
}

async function waitForPort(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const children = new Map();

function startModule(mod) {
  return new Promise((resolve) => {
    const entry = join(ROOT, 'modules', mod.dir, 'src', 'index.js');
    const child = spawn(process.execPath, [entry], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(mod.port) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    children.set(mod.id, child);

    child.stdout.on('data', (d) => {
      for (const line of d.toString().split('\n')) if (line.trim()) console.log(prefix(mod, line.trimEnd()));
    });
    child.stderr.on('data', (d) => {
      for (const line of d.toString().split('\n')) if (line.trim()) console.log(prefix(mod, `${C.red}${line.trimEnd()}${C.reset}`));
    });
    child.on('exit', (code, signal) => {
      children.delete(mod.id);
      if (code === 0 || signal === 'SIGINT' || signal === 'SIGTERM') console.log(prefix(mod, `${C.dim}arrêté proprement${C.reset}`));
      else console.log(prefix(mod, `${C.red}❌ crashé (code ${code}, signal ${signal})${C.reset}`));
    });
    child.on('error', (err) => console.log(prefix(mod, `${C.red}❌ ${err.message}${C.reset}`)));

    waitForPort(mod.port).then((ok) => {
      if (ok) console.log(prefix(mod, `${C.green}✅ prêt sur http://localhost:${mod.port}${C.reset}`));
      else console.log(prefix(mod, `${C.yellow}⚠️  port ${mod.port} pas ouvert après 15s${C.reset}`));
      resolve(ok);
    });
  });
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${C.yellow}⏹  ${signal} reçu → arrêt de ${children.size} module(s)…${C.reset}\n`);
  for (const [id, child] of children.entries()) {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGTERM');
      console.log(`  ${C.dim}→ ${id} arrêté${C.reset}`);
    } catch (e) { console.log(`  ${C.red}× ${id} : ${e.message}${C.reset}`); }
  }
  setTimeout(() => { console.log(`\n${C.green}✅ Tous les modules arrêtés.${C.reset}\n`); process.exit(0); }, 500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', () => {
  if (!shuttingDown) for (const [, c] of children.entries()) { try { c.kill('SIGTERM'); } catch {} }
});

async function main() {
  console.log(`\n${C.bold}${C.blue}🚀 DocForge AI — Démarrage de ${modulesToRun.length} module(s)${C.reset}`);
  console.log(`${C.dim}${ts()}${C.reset} — Racine : ${ROOT}\n`);
  // NOUVEAU : nettoyage des orphelins
  await killOrphans(modulesToRun.map((m) => m.port));

  for (const mod of modulesToRun) {
    if (await isPortOpen(mod.port)) {
      console.log(`${C.yellow}⚠️  Port ${mod.port} (${mod.id}) déjà occupé.${C.reset}`);
    }
  }

  for (const mod of modulesToRun) await startModule(mod);

  console.log(`\n${C.bold}${C.green}✅ Tous les modules sont prêts.${C.reset}`);
  console.log(`${C.dim}${ts()}${C.reset} — Front web : ${C.cyan}http://localhost:3005${C.reset}\n`);
  console.log(`${C.dim}Ctrl+C pour tout arrêter.${C.reset}\n`);
}

main().catch((err) => { console.error(`${C.red}Erreur fatale : ${err.message}${C.reset}`); shutdown('FATAL'); });
