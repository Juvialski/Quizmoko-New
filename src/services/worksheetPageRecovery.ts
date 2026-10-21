import { createHash, randomUUID } from 'node:crypto';
import type { ExtractedWorksheetPage } from './worksheetPipeline.ts';
interface Recovery {
  id: string; owner: string; fingerprint: string; updated: number;
  pages: Map<string, ExtractedWorksheetPage>;
}
const sessions = new Map<string, Recovery>();
const TTL = 30 * 60 * 1000;
const MAX_BYTES = 24 * 1024 * 1024;
export function worksheetRecovery(owner: string, files: Express.Multer.File[], id?: string): Recovery {
  for (const [key, value] of sessions) if (Date.now()-value.updated > TTL) sessions.delete(key);
  const hash = createHash('sha256');
  for (const file of files) hash.update(file.originalname).update('\0').update(file.buffer);
  const fingerprint = hash.digest('hex');
  if (id) {
    const prior = sessions.get(id);
    if (!prior || prior.owner !== owner || prior.fingerprint !== fingerprint) {
      throw Object.assign(new Error('Recovery expired or source files changed. Upload the original files again.'), {status:409});
    }
    prior.updated = Date.now(); return prior;
  }
  if (sessions.size >= 20) throw Object.assign(new Error('Worksheet recovery capacity is busy. Retry later.'),{status:429});
  const session: Recovery = {id:randomUUID(),owner,fingerprint,updated:Date.now(),pages:new Map()};
  sessions.set(session.id,session); return session;
}
export function rememberWorksheetPage(recovery: Recovery, key: string, page: ExtractedWorksheetPage) {
  let bytes = 0;
  for (const session of sessions.values()) for (const value of session.pages.values()) bytes += Buffer.byteLength(JSON.stringify(value));
  if (bytes + Buffer.byteLength(JSON.stringify(page)) > MAX_BYTES) return false;
  recovery.pages.set(key, structuredClone(page)); recovery.updated=Date.now(); return true;
}
