import fs from 'node:fs';
import { buildApp } from './app.js';
import { config } from './config.js';

const main = async (): Promise<void> => {
  fs.mkdirSync(config.dataDir, { recursive: true });

  const app = await buildApp();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
