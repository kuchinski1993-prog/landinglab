// Conexão BullMQ única para as filas VSL (produtor e consumidor no mesmo VSL_REDIS_URL).
export interface VslRedisConnection {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db: number;
  tls?: Record<string, never>;
  maxRetriesPerRequest: null;
}

export function vslRedisConnection(redisUrl: string): VslRedisConnection {
  let url: URL;
  try { url = new URL(redisUrl); } catch { throw new Error('Invalid VSL_REDIS_URL'); }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') throw new Error('VSL_REDIS_URL must use redis:// or rediss://');
  const db = Number(url.pathname.slice(1) || 0);
  if (!Number.isInteger(db) || db < 0) throw new Error('Invalid VSL_REDIS_URL database');
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    db,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}
