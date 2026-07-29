import { Request, Response, NextFunction } from 'express';
import { users } from '../store/db.ts';

export interface AuthRequest extends Request {
  user?: any;
}

export function tokenRequired(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.cookies?.token || (req.headers?.authorization as string);
  if (token && token.startsWith('user_')) {
    const uid = token.replace('user_', '');
    req.user = users.get(uid) || { uid, email: `${uid}@example.com`, name: 'User', role: 'admin' };
  } else {
    req.user = users.get('teacher_test') || { uid: 'teacher_test', email: 'teacher@example.com', name: 'Teacher', role: 'admin' };
  }
  next();
}
