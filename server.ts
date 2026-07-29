import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import cookieParser from 'cookie-parser';
import { apiNotFound, errorHandler } from './src/middleware/errorHandler.ts';
import { registerRoutes } from './src/routes/index.ts';
import {
  handleStartupFailure,
  installGracefulShutdown,
  startHttpServer
} from './src/services/serverLifecycle.ts';
import { initSocketServer } from './src/services/socket.ts';

const app = express();
const server = http.createServer(app);

app.disable('x-powered-by');
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY);
} else if (process.env.RENDER) {
  app.set('trust proxy', 1);
}

const io = initSocketServer(server);
app.set('io', io);

app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'views'));

const requestSizeLimit = process.env.MAX_REQUEST_BODY_SIZE || '25mb';
app.use(express.json({ limit: requestSizeLimit }));
app.use(express.urlencoded({ extended: true, limit: requestSizeLimit }));
app.use(cookieParser());
app.use(express.static(path.join(process.cwd(), 'public')));

registerRoutes(app);
app.all('/api/*', apiNotFound);
app.use(errorHandler);

installGracefulShutdown(server, io);
void startHttpServer(server).catch(handleStartupFailure);
