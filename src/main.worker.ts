/**
 * The worker entrypoint (`node dist/main.worker.js`, `npm run dev:worker`).
 *
 * WHY a second file when main.ts already branches on APP_ROLE: the Dockerfile picks the entrypoint
 * from APP_ROLE, and a deployment that sets the role but keeps the api entrypoint — or the reverse
 * — is a silent misconfiguration. Having a file that can ONLY be the worker means the container
 * command and the env var have to disagree twice before anything goes wrong, and WorkerBootstrapService
 * refuses to start if APP_ROLE is not `worker`, which catches the remaining case.
 */
import '@common/helpers/bigint-json';

import { bootstrapWorker } from './main';

bootstrapWorker().catch((error: unknown) => {
  console.error('Fatal error during worker bootstrap:', error);
  process.exit(1);
});
