import { createApp } from './app.js';
import { env } from './env.js';
import { startTokenCleanupLoop } from './lib/ttl.js';

const app = createApp();

startTokenCleanupLoop();

app.listen(env.PORT, () => {
  console.log(`BlindNav server listening on http://127.0.0.1:${env.PORT}`);
});

