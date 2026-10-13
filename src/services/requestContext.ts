import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandler } from 'express';

const requests = new AsyncLocalStorage<AbortSignal>();
export const requestContext: RequestHandler = (req, res, next) => {
  const controller = new AbortController();
  const abandon = () => { if (!res.writableEnded) controller.abort(); };
  req.once('aborted', abandon);
  res.once('close', abandon);
  res.once('finish', () => req.off('aborted', abandon));
  requests.run(controller.signal, next);
};
export function requestAbortSignal(): AbortSignal | undefined { return requests.getStore(); }

export function waitWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(signal.reason || new DOMException('Cancelled', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new DOMException('Cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
