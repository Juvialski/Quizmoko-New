import type { Server as HttpServer } from 'http';
import type { Server as SocketServer } from 'socket.io';
import {
  PORT,
  flushPendingPersistence,
  initDatabase
} from '../store/db.ts';

export function installGracefulShutdown(server: HttpServer, io: SocketServer): void {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Server] ${signal} received; draining requests and persistence.`);

    const requestsDrained = new Promise<boolean>((resolve) => {
      if (!server.listening) {
        resolve(true);
        return;
      }
      server.close((error) => {
        if (error) console.warn('[Server] HTTP drain warning:', error.message);
        resolve(!error);
      });
    });
    io.close();

    const drainDeadline = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      timer.unref();
    });
    const [flushed, drained] = await Promise.all([
      flushPendingPersistence(10_000),
      Promise.race([requestsDrained, drainDeadline])
    ]);
    if (!flushed) console.warn('[Persistence] Shutdown flush timed out; verify Firestore connectivity.');
    if (!drained) console.warn('[Server] Shutdown request drain timed out.');
    process.exit(flushed && drained ? 0 : 1);
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

export async function startHttpServer(server: HttpServer): Promise<void> {
  await initDatabase();
  await new Promise<void>((resolve, reject) => {
    const onStartupError = (error: Error) => reject(error);
    server.once('error', onStartupError);
    server.listen(PORT, '0.0.0.0', () => {
      server.off('error', onStartupError);
      console.log(`QuizMoKo server running on http://0.0.0.0:${PORT}`);
      resolve();
    });
  });
  server.on('error', (error) => console.error('[Server] Listener error:', error));
}

export async function handleStartupFailure(error: unknown): Promise<never> {
  console.error('[Server] Startup failed:', error);
  await flushPendingPersistence(5_000);
  process.exit(1);
}
