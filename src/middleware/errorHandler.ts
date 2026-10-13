import type { ErrorRequestHandler, RequestHandler } from 'express';

export const apiNotFound: RequestHandler = (req, res) => {
  res.status(404).json({
    success: false,
    error: `API route ${req.originalUrl} not found`
  });
};

export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const multerLimit = typeof error?.code === 'string' && error.code.startsWith('LIMIT_');
  const status = error?.status
    || error?.statusCode
    || (multerLimit ? 413 : undefined)
    || (error instanceof SyntaxError ? 400 : 500);
  const message = status === 400
    ? 'Invalid request payload'
    : status === 413
      ? 'Request payload is too large'
      : status === 503 ? 'Service temporarily unavailable; retry shortly'
      : status === 429 ? 'Too many requests; retry shortly' : 'Internal server error';

  if (error?.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds));
  console.error(`[HTTP] ${req.method} ${req.path} failed (status ${status}).`);

  if (req.originalUrl.startsWith('/api/') || req.accepts(['html', 'json']) === 'json') {
    res.status(status).json({ success: false, error: message });
    return;
  }
  res.status(status).send(message);
};
