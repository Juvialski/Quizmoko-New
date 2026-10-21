import sharp from 'sharp';
import { verifyMathematicalAnswer, verifyNumericAnswer, verifySolutionCalculations } from './mathVerification.ts';

export interface GradingRubric {
  version: 1;
  criteria: { id: string; description: string; weight: number }[];
}
export interface MathematicalResponseContract {
  version: 1;
  mode: 'final_answer';
  absolute_tolerance?: string;
}
export function validateRubric(value: unknown): value is GradingRubric {
  const r = value as GradingRubric;
  return Boolean(r && r.version === 1 && Array.isArray(r.criteria) && r.criteria.length > 0 && r.criteria.length <= 10
    && r.criteria.every(c => c && typeof c.id === 'string' && /^[a-z][a-z0-9_]{0,39}$/i.test(c.id)
      && typeof c.description === 'string' && c.description.trim().length > 0 && c.description.length <= 1000
      && typeof c.weight === 'number' && Number.isFinite(c.weight) && c.weight > 0 && c.weight <= 1)
    && new Set(r.criteria.map(c => c.id)).size === r.criteria.length
    && Math.abs(r.criteria.reduce((s,c) => s+c.weight,0)-1) < 1e-8);
}
export function validateResponseContract(value: unknown): value is MathematicalResponseContract {
  const r = value as MathematicalResponseContract;
  return Boolean(r && r.version === 1 && r.mode === 'final_answer'
    && (r.absolute_tolerance === undefined || (typeof r.absolute_tolerance === 'string'
      && /^\d+(?:\.\d+)?$/.test(r.absolute_tolerance) && r.absolute_tolerance.length <= 32)));
}

/** An explicit teacher final-answer contract is required. Never scores work or invents weights. */
export function deterministicSemanticAnswer(question: any, answer: unknown, hasSnapshots = false): {
  outcome: 'correct' | 'incorrect' | 'inconclusive'; reason: string;
} {
  const fallback = { outcome: 'inconclusive' as const, reason: 'No applicable complete final-answer contract.' };
  if (!validateResponseContract(question?.response_contract) || question?.grading_rubric || hasSnapshots
    || question?.type === 'graphing' || /show|explain|justify|prove|reason|steps|work|units?|round/i.test(String(question?.question))) return fallback;
  if (typeof answer !== 'string' || !answer.trim()) return fallback;
  const key = String(question.answer ?? '');
  // First certify the authoritative key independently. Unsupported or incorrect keys do not grade students.
  const keyCheck = verifyMathematicalAnswer(question.question, key);
  if (keyCheck.outcome !== 'pass') return fallback;
  const result = question.response_contract.absolute_tolerance !== undefined
    ? verifyNumericAnswer(key, answer, question.response_contract.absolute_tolerance)
    : verifyMathematicalAnswer(question.question, answer);
  return { outcome: result.outcome === 'pass' ? 'correct' : result.outcome === 'fail' ? 'incorrect' : 'inconclusive', reason: result.reason };
}

export function rubricGradeIssues(payload: any, rubric: GradingRubric): string[] {
  const rows = payload?.criteria;
  if (!Array.isArray(rows) || rows.length !== rubric.criteria.length) return ['Missing rubric criterion coverage.'];
  const seen = new Set<string>(); let weighted = 0;
  for (const criterion of rubric.criteria) {
    const row = rows.find((r: any) => r?.id === criterion.id);
    if (!row || seen.has(row.id) || rows.filter((r:any)=>r?.id===criterion.id).length !== 1
      || typeof row.score_fraction !== 'number' || !Number.isFinite(row.score_fraction)
      || row.score_fraction < 0 || row.score_fraction > 1 || typeof row.evidence !== 'string' || !row.evidence.trim()) return ['Invalid or unsupported rubric evidence.'];
    // A generic label supplies no partial-credit anchors. Live evaluation showed
    // two defensible allocations for the same correct first step. Preserve the
    // answer for teacher review rather than silently selecting either allocation.
    if (row.score_fraction > 0 && row.score_fraction < 1
      && /^(?:valid|correct|appropriate|sound)\s+(?:equation\s+)?(?:method|reasoning|work|steps|transformation)\.?$/i.test(criterion.description.trim())) {
      return [`Partial credit for criterion "${criterion.id}" needs explicit step criteria or teacher review.`];
    }
    seen.add(row.id); weighted += criterion.weight * row.score_fraction;
  }
  return Math.abs(weighted - payload.score_fraction) > 0.0001 ? ['Score contradicts the teacher-weighted rubric.'] : [];
}

/** Decodes existing inline images with bounded pixels; does not persist or duplicate snapshots. */
export async function validateGradingImages(images: string[]): Promise<string | null> {
  if (images.length > 5 || images.reduce((s,i)=>s+String(i).length,0) > 10*1024*1024) return 'Image count or size exceeds the grading limit.';
  for (const image of images) {
    const m = typeof image === 'string' && image.match(/^data:image\/(png|jpe?g|gif|webp);base64,([a-z0-9+/]+={0,2})$/i);
    if (!m || m[2].length % 4 !== 0) return 'Missing, malformed or unsupported solution image.';
    try {
      const processor = sharp(Buffer.from(m[2], 'base64'), { limitInputPixels: 12_000_000 });
      const meta = await processor.metadata();
      const expected = /jpe?g/i.test(m[1]) ? 'jpeg' : m[1].toLowerCase();
      if (meta.format !== expected || !meta.width || !meta.height || meta.width < 2 || meta.height < 2
        || meta.width > 10000 || meta.height > 10000 || (meta.pages || 1) !== 1) return 'Unsupported or invalid image dimensions.';
      // Force decoding: metadata alone does not detect truncated image data.
      await processor.resize(16,16,{fit:'inside'}).raw().toBuffer();
      const stats = await sharp(Buffer.from(m[2],'base64'),{limitInputPixels:12_000_000}).flatten({background:'white'}).stats();
      if(stats.channels.every(c=>c.stdev===0)) return 'The supplied image is uniformly blank; no readable work is established.';
    } catch { return 'Solution image could not be decoded. Please attach a readable image.'; }
  }
  return null;
}

export function gradingEvidenceIssues(payload: any, question: any, answer: unknown, hasSnapshots: boolean): string[] {
  const issues: string[] = [];
  if (question.grading_rubric) issues.push(...rubricGradeIssues(payload, question.grading_rubric));
  if (payload.evidence_status === 'unreadable' || payload.evidence_status === 'insufficient') issues.push('The model could not inspect sufficient evidence.');
  if (hasSnapshots && payload.evidence_status !== 'readable') issues.push('Snapshot readability was not established.');
  if (payload.score_fraction === 1 && /show|explain|justify|prove|reason|steps|work/i.test(question.question)) {
    if (typeof payload.justification !== 'string' || !payload.justification.trim()) issues.push('Full credit lacks demonstrated reasoning justification.');
  }
  if (payload.score_fraction === 1 && /\b(?:incorrect|missing|invalid|not demonstrated|arithmetic error|partially correct)\b/i.test(payload.feedback)) issues.push('Full-credit feedback describes incomplete or incorrect work.');
  if (payload.score_fraction === 1 && verifySolutionCalculations(answer).outcome === 'fail') issues.push('Full credit contradicts an explicit invalid student calculation.');
  if (payload.score_fraction === 0 && /\b(?:fully correct|mostly correct|correct method|valid intermediate)\b/i.test(payload.feedback)) issues.push('Zero-credit feedback describes demonstrated correctness.');
  // Answer equivalence alone never grants partial credit or rejects an alternate method.
  const local = deterministicSemanticAnswer(question, answer, hasSnapshots);
  if ((local.outcome === 'correct' && payload.score_fraction !== 1) || (local.outcome === 'incorrect' && payload.score_fraction !== 0)) issues.push('Score contradicts the complete deterministic answer contract.');
  return issues;
}
