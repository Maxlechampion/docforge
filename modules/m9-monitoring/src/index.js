/**
 * DocForge AI — m9-monitoring
 * Rôle : Health, métriques, logs
 *
 * Point d'entrée du module. Isolé par contrat (voir shared/contracts/v1).
 */
import Fastify from 'fastify';

const app = Fastify({ logger: true });

app.get('/health', async () => ({ status: 'ok', module: 'M9' }));

const port = Number(process.env.PORT || 3009);
try {
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`🚀 m9-monitoring → http://localhost:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

const shutdown = async (sig) => {
  console.log(`\n⏹  ${sig} → arrêt propre m9-monitoring`);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
