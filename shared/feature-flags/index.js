/**
 * Feature flags — désactivation à chaud (contrainte 0.2 §4.3.2).
 * Source de vérité : table PostgreSQL `feature_flags`.
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
    `INSERT INTO feature_flags (name, enabled) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET enabled = EXCLUDED.enabled`,
    [flagName, enabled]
  );
  cache.delete(flagName);
}
