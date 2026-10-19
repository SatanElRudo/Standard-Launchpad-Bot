import { createApp } from './app.mjs';
const app = createApp();
app.server.listen(4317, '127.0.0.1', () => console.log('Standard Launch Console: http://127.0.0.1:4317'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close().then(() => process.exit(0)));
