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
      : 'Internal server error';

  console.error(
    `[HTTP] ${req.method} ${req.originalUrl} failed:`,
    error instanceof Error ? error.message : 'unknown error'
  );

  if (req.originalUrl.startsWith('/api/') || req.accepts(['html', 'json']) === 'json') {
    res.status(status).json({ success: false, error: message });
    return;
  }
  res.status(status).send(message);
};
