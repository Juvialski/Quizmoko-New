import type { Request, Response, NextFunction } from 'express';
import type { AuthRequest } from './auth.ts';

interface RateLimitRule {
  windowMs: number;
  max: number;
  message: string;
}

const limits = new Map<string, { count: number; resetTime: number }>();

/**
 * Clean up expired rate limit entries to prevent memory leaks
 */
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of limits.entries()) {
    if (now > record.resetTime) {
      limits.delete(key);
    }
  }
}, 60000).unref();

export function createRateLimiter(rule: RateLimitRule, prefix: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Determine unique identifier: authenticated user ID or fallback to IP address
    const authReq = req as AuthRequest;
    const identifier = authReq.user?.uid || req.ip || 'unknown';
    const key = `${prefix}:${identifier}`;
    const now = Date.now();

    const record = limits.get(key);

    if (!record || now > record.resetTime) {
      // Create new record
      limits.set(key, {
        count: 1,
        resetTime: now + rule.windowMs
      });
      return next();
    }

    if (record.count >= rule.max) {
      const waitSeconds = Math.ceil((record.resetTime - now) / 1000);
      res.status(429);
      
      // If the request expects JSON, return JSON, otherwise render a generic error or return text
      if (req.xhr || req.headers.accept?.includes('json') || req.path.startsWith('/api/') || req.path === '/merge') {
        return res.json({
          success: false,
          error: `${rule.message} Please wait ${waitSeconds}s.`
        });
      }
      
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>Spam Prevention - QuizMoKo</title>
          <link rel="preconnect" href="https://fonts.googleapis.com">
          <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
          <style>
            body {
              font-family: 'Inter', sans-serif;
              background-color: #090d16;
              color: #f8fafc;
              display: flex;
              justify-content: center;
              align-items: center;
              min-height: 100vh;
              margin: 0;
            }
            .card {
              background: #131927;
              border: 1px solid rgba(255, 255, 255, 0.05);
              padding: 40px;
              border-radius: 16px;
              max-width: 450px;
              text-align: center;
              box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
            }
            h1 {
              color: #fb7185;
              font-size: 24px;
              margin-top: 0;
            }
            p {
              color: #94a3b8;
              line-height: 1.6;
              font-size: 14px;
            }
            .btn {
              display: inline-block;
              background: #818cf8;
              color: white;
              padding: 12px 24px;
              border-radius: 8px;
              text-decoration: none;
              font-weight: 600;
              margin-top: 20px;
              transition: 0.2s;
            }
            .btn:hover {
              opacity: 0.9;
            }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Too Many Requests</h1>
            <p>${rule.message}</p>
            <p>Please wait <strong>${waitSeconds} second(s)</strong> before trying again.</p>
            <a href="/" class="btn">Back to Dashboard</a>
          </div>
        </body>
        </html>
      `);
    }

    record.count += 1;
    limits.set(key, record);
    return next();
  };
}

// Pre-configured rate limiters
export const createQuizLimiter = createRateLimiter({
  windowMs: 5000, // 5 seconds window
  max: 1, // Max 1 quiz creation attempt per 5 seconds
  message: 'Anti-Spam Shield: You are creating quizzes too quickly.'
}, 'create-quiz');

export const generateAiLimiter = createRateLimiter({
  windowMs: 8000, // 8 seconds window
  max: 1, // Max 1 AI generation per 8 seconds
  message: 'Anti-Spam Shield: AI Quiz generation requests are being rate-limited to avoid model overload.'
}, 'generate-ai');

export const loginLimiter = createRateLimiter({
  windowMs: 60000, // 1 minute window
  max: 10, // Max 10 login attempts per minute
  message: 'Security Guard: Too many login attempts detected from your client.'
}, 'login');
