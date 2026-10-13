import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { startHttpServer } from '../src/services/serverLifecycle.ts';
import { users, quizzes } from '../src/store/db.ts';

process.env.SESSION_SECRET = randomBytes(32).toString('hex');
process.env.TRUSTED_ORIGINS = 'https://quiz.example.invalid';
assert.equal(users.has('teacher_test'), false);
assert.equal(quizzes.has('quiz_algebra_101'), false);
const server = http.createServer();
await assert.rejects(startHttpServer(server), /Firestore startup requirement/);
assert.equal(server.listening, false);
console.log('Production startup rejected missing credentials before accepting traffic; demo records absent.');
