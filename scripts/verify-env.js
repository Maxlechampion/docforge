#!/usr/bin/env node
/**
 * Vérifie que l'environnement respecte les prérequis du projet.
 * Exécuté automatiquement par `npm install` via `preinstall`.
 */
import { readFileSync, existsSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));
const nodeMajor = Number(process.versions.node.split('.')[0]);
const required = pkg.engines?.node || '>=20';

const MIN_MAJOR = 20;
const MAX_MAJOR = 21;

let ok = true;

// 1. Vérification Node
if (nodeMajor < MIN_MAJOR || nodeMajor >= MAX_MAJOR) {
  console.error(`❌ Node.js ${process.versions.node} détecté. Requis : ${required}`);
  console.error(`   → Installe Node 20 LTS : https://nodejs.org`);
  ok = false;
} else {
  console.log(`✅ Node.js ${process.versions.node} OK`);
}

// 2. Vérification .env
if (!existsSync('.env') && existsSync('.env.example')) {
  console.warn(`⚠️  .env absent. Copie .env.example → .env :`);
  console.warn(`   Copy-Item .env.example .env`);
}

// 3. Vérification lockfile
if (!existsSync('package-lock.json')) {
  console.warn(`⚠️  package-lock.json absent → npm install va le créer`);
}

// 4. Vérification des workspaces
if (!pkg.workspaces || pkg.workspaces.length === 0) {
  console.warn(`⚠️  Aucun workspace déclaré dans package.json`);
}

if (!ok) process.exit(1);