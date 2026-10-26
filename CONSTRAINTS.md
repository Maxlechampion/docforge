# Contraintes techniques DocForge AI

Documente les décisions critiques du projet. **Ne pas modifier sans validation.**

## 1. Node.js verrouillé sur 20.x

- Version : `20.20.0` (voir `.nvmrc`)
- Raison : Node 20 est LTS jusqu'en avril 2026.
- Conséquence : tout package exigeant Node ≥ 22 doit être évité ou surchargé via `overrides`.

## 2. Fastify verrouillé sur 4.x

- Version : `4.29.1`
- Raison : Fastify 5 tire `cookie@2.0.1` qui exige Node ≥ 22. Incompatible avec Node 20.
- Conséquence : tous les modules utilisent `fastify@^4.29.1`. **Ne pas** upgrade vers Fastify 5 tant que Node n'est pas passé en 22.
- Plan de sortie : upgrade groupé lors du passage à Node 22 (mi-2026).

## 3. `@fastify/multipart` verrouillé sur 8.x

- Version : `^8.3.0`
- Raison : v10 exige Fastify 5.x. v8 est la dernière compatible Fastify 4.
- Concerné : uniquement M1 (ingestion).

## 4. Override `nanoid@5.1.6`

- Raison : `nanoid@6` (dépendance transitive de `docx`) exige Node ≥ 22.
- Emplacement : `package.json` racine (`overrides`).
- Ne **pas** supprimer tant qu'on est sur Node 20.

## 5. Package manager : npm 10.x

- Version : `10.8.2`
- Install reproductible : `npm ci` (jamais `npm install` en CI/prod).

## 6. LLM : Groq free tier + fallback heuristique

- Modèle actuel : `openai/gpt-oss-120b`
- Ancien `llama-3.3-70b-versatile` décommissionné août 2026.
- Tous les modules LLM (M2, M3) doivent avoir un fallback heuristique pur JS.
- Charge `.env` via `dotenv/config` en haut de chaque `src/index.js`.
## 7. `@fastify/cors` verrouillé sur 8.x

- Version : `^8.5.0`
- Raison : v10 et v11 exigent Fastify 5.x. v8 est la dernière compatible Fastify 4.
- Concerné : M1, M2, M3, M4, M5.
- Ne **pas** upgrade tant que Fastify reste en 4.x.
## 8. `@fastify/static` verrouillé sur 7.x

- Version : `^7.0.0`
- Raison : v8+ exige Fastify 5.x. v7 est la dernière compatible Fastify 4.
- Concerné : M5 uniquement (sert le front HTML).
- Ne **pas** upgrade tant que Fastify reste en 4.x.