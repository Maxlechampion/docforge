/**
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
