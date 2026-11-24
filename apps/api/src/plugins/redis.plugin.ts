// Redis plugin — shared ioredis connection used by health check and queue producer.
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { Redis } from 'ioredis';

const redisPlugin: FastifyPluginAsync = async (fastify) => {
  // BullMQ requires maxRetriesPerRequest=null on the producer connection.
  const redis = new Redis(fastify.config.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });

  redis.on('error', (err: Error) => {
    fastify.log.error({ err }, 'Redis connection error');
  });

  fastify.decorate('redis', redis);
  fastify.addHook('onClose', async () => {
    await redis.quit().catch(() => {
      redis.disconnect();
    });
  });
};

export default fp(redisPlugin, { name: 'redis-plugin' });
