/** Bounded exact arithmetic. No execution, numerical sampling, or model-supplied oracle. */
export type MathOutcome = 'pass' | 'fail' | 'inconclusive';
export interface MathEvidence { outcome: MathOutcome; category: string; reason: string; version: string }
export const MATH_VERIFIER_VERSION = 'math-v1';
type Q = { n: bigint; d: bigint };
type Poly = Map<string, Q>; // monomials x^i y^j; denominator is always constant
class Unsupported extends Error {}
class UndefinedMath extends Error {}
const gcd = (a: bigint, b: bigint): bigint => b ? gcd(b, a % b) : (a < 0n ? -a : a);
function q(n: bigint, d = 1n): Q {
  if (!d) throw new UndefinedMath('Division by zero.');
  if (n.toString().length + d.toString().length > 2048) throw new Unsupported('Arithmetic size limit.');
  const g = gcd(n, d); return { n: n / g * (d < 0n ? -1n : 1n), d: d / g * (d < 0n ? -1n : 1n) };
}
const add = (a: Q, b: Q) => q(a.n * b.d + b.n * a.d, a.d * b.d);
const mul = (a: Q, b: Q) => q(a.n * b.n, a.d * b.d);
const neg = (a: Q) => q(-a.n, a.d);
const eq = (a: Q, b: Q) => a.n === b.n && a.d === b.d;
const zero = q(0n), one = q(1n);
const constant = (a: Q): Poly => new Map(a.n ? [['0,0', a]] : []);
const scalar = (p: Poly): Q => { if ([...p.keys()].some(k => k !== '0,0')) throw new Unsupported('Not a constant.'); return p.get('0,0') || zero; };
function sum(a: Poly, b: Poly, sign = 1): Poly {
  const out = new Map(a);
  for (const [k, v] of b) { const r = add(out.get(k) || zero, sign === 1 ? v : neg(v)); if (r.n) out.set(k, r); else out.delete(k); }
  return out;
}
function product(a: Poly, b: Poly): Poly {
  let out: Poly = new Map();
  for (const [k, v] of a) for (const [l, w] of b) {
    const [i, j] = k.split(',').map(Number), [r, s] = l.split(',').map(Number);
    if (i + j + r + s > 8) throw new Unsupported('Polynomial degree limit.');
    out = sum(out, new Map([[`${i + r},${j + s}`, mul(v, w)]]));
  }
  return out;
}
function exactRoot(a: Q): Q {
  if (a.n < 0n) throw new UndefinedMath('Negative real square root.');
  const root = (n: bigint) => { let lo = 0n, hi = n + 1n; while (hi - lo > 1n) { const mid = (hi + lo) / 2n; if (mid * mid > n) hi = mid; else lo = mid; } if (lo * lo !== n) throw new Unsupported('Irrational root.'); return lo; };
  return q(root(a.n), root(a.d));
}
export function mathText(value: unknown): string {
  let s = String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/\$/g, '').replace(/\\(?:left|right)\b/g, '')
    .replace(/\\(?:times|cdot)/g, '*').replace(/\\div/g, '/').replace(/[−–]/g, '-').replace(/×/g, '*')
    .replace(/\\%/g, '%').replace(/\\[,;!]/g, ' ');
  // Bounded nested LaTeX fraction expansion.
  for (let i = 0; i < 12 && /\\(?:d?frac|tfrac|sqrt)/.test(s); i++) {
    const next = s.replace(/\\(?:d?frac|tfrac)\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '(($1)/($2))')
      .replace(/\\sqrt\s*\{([^{}]*)\}/g, 'sqrt($1)');
    if (next === s) break; s = next;
  }
  return s.replace(/\{([^{}]*)\}/g, '($1)').trim();
}
function parse(value: unknown, env: Record<string, Q> = {}): Poly {
  const s = mathText(value);
  if (s.length > 512) throw new Unsupported('Expression length limit.');
  const tokens = s.match(/sqrt|\d+(?:\.\d+)?|\.\d+|[xy()+\-*/^%]/g) || [];
  if (tokens.join('') !== s.replace(/\s/g, '') || tokens.length > 200) throw new Unsupported('Unsupported expression syntax.');
  let at = 0;
  const peek = () => tokens[at];
  const atom = (): Poly => {
    const t = tokens[at++];
    if (t === '(') { const p = expr(); if (tokens[at++] !== ')') throw new Unsupported('Unbalanced parentheses.'); return p; }
    if (t === 'sqrt') { if (tokens[at++] !== '(') throw new Unsupported('Root syntax.'); const p = expr(); if (tokens[at++] !== ')') throw new Unsupported('Root syntax.'); return constant(exactRoot(scalar(p))); }
    if (t === 'x' || t === 'y') return env[t] ? constant(env[t]) : new Map([[t === 'x' ? '1,0' : '0,1', one]]);
    if (!t || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(t)) throw new Unsupported('Expected number or variable.');
    const [whole, dec = ''] = t.split('.'); return constant(q(BigInt((whole || '0') + dec), 10n ** BigInt(dec.length)));
  };
  const power = (): Poly => {
    let p = atom();
    if (peek() === '^') { at++; const n = scalar(unary()); if (n.d !== 1n || n.n < -64n || n.n > 64n) throw new Unsupported('Exponent domain.');
      if (!p.size && n.n === 0n) throw new UndefinedMath('Zero to zero power is not established.');
      if (n.n < 0n) { const v = scalar(p); if (!v.n) throw new UndefinedMath('Zero to negative power.'); p = constant(q(v.d, v.n)); }
      let r = constant(one); for (let i = 0; i < Number(n.n < 0n ? -n.n : n.n); i++) r = product(r, p); p = r;
    }
    if (peek() === '%') { at++; p = product(p, constant(q(1n, 100n))); }
    return p;
  };
  const unary = (): Poly => { if (peek() === '+' || peek() === '-') { const sign = tokens[at++]; const p = unary(); return sign === '-' ? product(constant(q(-1n)), p) : p; } return power(); };
  const term = (): Poly => {
    let p = unary();
    while (peek() === '*' || peek() === '/' || peek() === '(' || peek() === 'x' || peek() === 'y' || peek() === 'sqrt') {
      const op = peek(); if (op === '*' || op === '/') at++;
      const r = unary(); p = op === '/' ? product(p, constant((() => { const v = scalar(r); return q(v.d, v.n); })())) : product(p, r);
    }
    return p;
  };
  const expr = (): Poly => { let p = term(); while (peek() === '+' || peek() === '-') { const op = tokens[at++]; p = sum(p, term(), op === '+' ? 1 : -1); } return p; };
  const p = expr(); if (at !== tokens.length) throw new Unsupported('Trailing expression content.'); return p;
}
const evidence = (outcome: MathOutcome, category: string, reason: string): MathEvidence => ({ outcome, category, reason, version: MATH_VERIFIER_VERSION });
export function verifyMathExpression(left: unknown, right: unknown): MathEvidence {
  try { return evidence(sum(parse(left), parse(right), -1).size === 0 ? 'pass' : 'fail', 'polynomial_equivalence', 'Exact polynomial comparison over real x,y with constant nonzero denominators.'); }
  catch (error) { return evidence(error instanceof UndefinedMath ? 'fail' : 'inconclusive', 'expression', error instanceof Error ? error.message : 'Unsupported expression.'); }
}
function equation(text: string, env: Record<string, Q> = {}): Poly { const parts = text.split('='); if (parts.length !== 2) throw new Unsupported('Equation syntax.'); return sum(parse(parts[0], env), parse(parts[1], env), -1); }
function assignment(answer: string, variable = 'x'): Q { return scalar(parse(answer.replace(new RegExp(`^${variable}\\s*=\\s*`), ''))); }
function roots(p: Poly): Q[] {
  if ([...p.keys()].some(k => !['0,0', '1,0', '2,0'].includes(k))) throw new Unsupported('Equation domain.');
  const a = p.get('2,0') || zero, b = p.get('1,0') || zero, c = p.get('0,0') || zero;
  if (!a.n) { if (!b.n) throw new Unsupported('Nonunique or empty equation solution.'); return [q(-c.n * b.d, c.d * b.n)]; }
  const discriminant = add(mul(b, b), neg(mul(q(4n), mul(a, c))));
  const r = exactRoot(discriminant), denom = mul(q(2n), a);
  const div = (n: Q) => q(n.n * denom.d, n.d * denom.n);
  const first = div(add(neg(b), r)), second = div(add(neg(b), neg(r)));
  return eq(first, second) ? [first] : [first, second];
}
type Claim = { category: string; check: (answer: string, candidate?: boolean) => MathEvidence };
function expectedClaim(expected: Q, category: string, unit?: string): Claim {
  return { category, check(answer) {
    const cleaned = mathText(answer).replace(/\\(?:text|mathrm)\(([^()]*)\)/g, '$1');
    const m = cleaned.match(/^(.+?)\s+(mm|cm|m|km|g|kg|s|min|h)(?:\^\(?([23])\)?)?$/);
    if (m && unit && m[2] + (m[3] ? '^' + m[3] : '') !== unit) return evidence('fail', category, 'Answer units contradict the requested units.');
    const actual = scalar(parse(m ? m[1] : cleaned));
    return evidence(eq(actual, expected) ? 'pass' : 'fail', category, 'Exact rational calculation from the complete supported question template.');
  } };
}
function recognize(question: unknown): Claim {
  if (/<img\b|\[TIKZ\]/i.test(String(question ?? ''))) throw new Unsupported('Visual conditions are outside deterministic textual proof.');
  const text = mathText(question).replace(/[?.]\s*$/, '').trim();
  let m: RegExpMatchArray | null;
  // Full templates only: no extracting one expression from an arbitrary word problem.
  if ((m = text.match(/^(?:What is|Evaluate|Calculate|Compute|Simplify|Find the value of)\s+(.+)$/i)) && !/[a-z]/i.test(m[1].replace(/sqrt/g, ''))) {
    return expectedClaim(scalar(parse(m[1])), 'arithmetic');
  }
  if ((m = text.match(/^What is\s+([\d.]+)%\s+of\s+([\d.]+)$/i))) return expectedClaim(mul(scalar(parse(m[1])), mul(q(1n,100n), scalar(parse(m[2])))), 'percentage');
  if ((m = text.match(/^Solve(?: for x)?\s+(.+)$/i))) {
    const eqs = m[1].split(/\s*(?:;|\band\b)\s*/);
    if (eqs.length === 2) {
      const ps = eqs.map(s => equation(s));
      if (ps.some(p => [...p.keys()].some(k => !['0,0','1,0','0,1'].includes(k)))) throw new Unsupported('Nonlinear system.');
      const [p,r] = ps, a = p.get('1,0') || zero, b = p.get('0,1') || zero, c = p.get('0,0') || zero;
      const d = r.get('1,0') || zero, e = r.get('0,1') || zero, f = r.get('0,0') || zero;
      if (!add(mul(a,e),neg(mul(b,d))).n) throw new Unsupported('Nonunique system.');
      return { category:'linear_system', check(answer) { const values = answer.match(/^x\s*=\s*(.+),\s*y\s*=\s*(.+)$/); if (!values) throw new Unsupported('System answer format.'); const env = { x: assignment(values[1]), y: assignment(values[2],'y') }; return evidence(eqs.every(s => equation(s,env).size === 0) ? 'pass' : 'fail','linear_system','Exact substitution into both independent linear equations.'); } };
    }
    if (eqs.length !== 1) throw new Unsupported('System size.');
    return { category: 'equation', check(answer, candidate) {
      const values = answer.replace(/^x\s*=\s*/, '').split(/\s*(?:,|\bor\b)\s*/).map(v => assignment(v));
      // Substitute in original syntax to retain denominator and radical restrictions.
      if (values.some(x => equation(eqs[0], { x }).size !== 0)) return evidence('fail', 'equation', 'Answer fails substitution into the original equation.');
      if (candidate) return evidence('pass','equation_substitution','Candidate satisfies the original equation; completeness is checked separately.');
      const required = roots(equation(eqs[0]));
      return evidence(required.length === values.length && required.every(r => values.some(v => eq(v,r))) ? 'pass' : 'fail', 'equation', 'Complete exact real solution set checked for a degree-at-most-two polynomial.');
    } };
  }
  if ((m = text.match(/^(?:Expand|Simplify|Factor)\s+(.+)$/i))) return { category:'polynomial_equivalence', check: a => {
    const result=verifyMathExpression(m![1],a);
    return /^Factor\b/i.test(text) && result.outcome==='pass' ? evidence('inconclusive','factorization','Polynomial equivalence established; required factorization form is unproven.') : result;
  } };
  if ((m = text.match(/^Find the (mean|median|range) of\s+([\d.,\s-]+)$/i))) {
    const values = m[2].split(',').map(v => scalar(parse(v))).sort((a,b) => a.n*b.d < b.n*a.d ? -1 : a.n*b.d > b.n*a.d ? 1 : 0);
    if (!values.length || values.length > 50) throw new Unsupported('Data size.');
    const expected = m[1].toLowerCase() === 'mean' ? mul(values.reduce(add,zero),q(1n,BigInt(values.length))) : m[1].toLowerCase() === 'range' ? add(values.at(-1)!,neg(values[0])) : values.length % 2 ? values[Math.floor(values.length/2)] : mul(add(values[values.length/2-1],values[values.length/2]),q(1n,2n));
    return expectedClaim(expected, 'statistics');
  }
  if ((m = text.match(/^Find the (slope|distance|midpoint) (?:between|of the points)\s*\(([^,]+),([^()]+)\)\s*(?:and|,)\s*\(([^,]+),([^()]+)\)$/i))) {
    const [a,b,c,d] = m.slice(2).map(v => scalar(parse(v))), dx = add(c,neg(a)), dy = add(d,neg(b));
    if (m[1].toLowerCase() === 'midpoint') { const x=mul(add(a,c),q(1n,2n)), y=mul(add(b,d),q(1n,2n)); return {category:'coordinate_geometry',check(answer) { const pair=answer.match(/^\(([^,]+),([^()]+)\)$/); if (!pair) throw new Unsupported('Coordinate answer syntax.'); return evidence(eq(scalar(parse(pair[1])),x) && eq(scalar(parse(pair[2])),y) ? 'pass':'fail','coordinate_geometry','Exact midpoint calculation.'); }}; }
    return expectedClaim(m[1].toLowerCase() === 'slope' ? q(dy.n*dx.d,dy.d*dx.n) : exactRoot(add(mul(dx,dx),mul(dy,dy))), 'coordinate_geometry');
  }
  if ((m = text.match(/^A rectangle has length\s+([\d.]+)\s+(mm|cm|m)\s+and width\s+([\d.]+)\s+\2\. What is its (area|perimeter)$/i))) {
    const a=scalar(parse(m[1])), b=scalar(parse(m[3])); if (a.n<=0n || b.n<=0n) throw new UndefinedMath('Nonpositive dimension.');
    return expectedClaim(m[4].toLowerCase()==='area' ? mul(a,b):mul(q(2n),add(a,b)), 'rectangle', m[2]+(m[4].toLowerCase()==='area'?'^2':''));
  }
  if ((m = text.match(/^A triangle has base\s+([\d.]+)\s+(mm|cm|m)\s+and height\s+([\d.]+)\s+\2\. What is its area$/i))) {
    const a=scalar(parse(m[1])),b=scalar(parse(m[3])); if(a.n<=0n || b.n<=0n) throw new UndefinedMath('Nonpositive dimension.');
    return expectedClaim(mul(mul(a,b),q(1n,2n)),'triangle',m[2]+'^2');
  }
  if ((m=text.match(/^Find the equation of the line through\s*\(([^,]+),([^()]+)\)\s*and\s*\(([^,]+),([^()]+)\)$/i))) {
    const [a,b,c,d]=m.slice(1).map(v=>scalar(parse(v))),dx=add(c,neg(a)),dy=add(d,neg(b));
    if(!dx.n && !dy.n) throw new UndefinedMath('Distinct points are required for a unique line.');
    const target:Poly=new Map([['0,1',dx],['1,0',neg(dy)],['0,0',add(mul(dy,a),neg(mul(dx,b)))]]);
    for(const [k,v] of target) if(!v.n) target.delete(k);
    return {category:'line_equation',check(answer) {
      const actual=equation(answer); if(!actual.size) return evidence('fail','line_equation','The answer is an identity rather than a line.');
      const [key,v]=[...target][0],w=actual.get(key)||zero;
      if(!w.n) return evidence('fail','line_equation','The line does not satisfy the two given points.');
      const scale=q(w.n*v.d,w.d*v.n);
      return evidence(sum(actual,product(target,constant(scale)),-1).size===0?'pass':'fail','line_equation','Exact comparison of the implicit line through two distinct points.');
    }};
  }
  if ((m = text.match(/^Convert\s+([\d.]+)\s+(mm|cm|m|km|g|kg|s|min|h)\s+to\s+(mm|cm|m|km|g|kg|s|min|h)$/i))) {
    const units: Record<string,[string,Q]> = {mm:['length',q(1n,1000n)],cm:['length',q(1n,100n)],m:['length',one],km:['length',q(1000n)],g:['mass',one],kg:['mass',q(1000n)],s:['time',one],min:['time',q(60n)],h:['time',q(3600n)]};
    const from=units[m[2]], to=units[m[3]]; if (from[0]!==to[0]) throw new UndefinedMath('Incompatible dimensions.');
    return expectedClaim(mul(scalar(parse(m[1])),q(from[1].n*to[1].d,from[1].d*to[1].n)), 'unit_conversion',m[3]);
  }
  if ((m = text.match(/^A bag contains\s+(\d+)\s+red and\s+(\d+)\s+blue balls\. What is the probability of drawing a red ball$/i))) return expectedClaim(q(BigInt(m[1]),BigInt(m[1])+BigInt(m[2])), 'probability');
  throw new Unsupported('Question is outside the complete supported templates.');
}
export function verifyMathematicalAnswer(question: unknown, answer: unknown, candidate = false): MathEvidence {
  try { return recognize(question).check(mathText(answer),candidate); }
  catch (error) { return evidence(error instanceof UndefinedMath ? 'fail' : 'inconclusive', 'unsupported_or_undefined', error instanceof Error ? error.message : 'Unsupported mathematics.'); }
}
/** Only checks explicit supported identities; does not certify the entire explanation. */
export function verifySolutionCalculations(solution: unknown): MathEvidence {
  const spans = [...String(solution ?? '').matchAll(/\$\$?([^$]+)\$\$?/g)].map(m => mathText(m[1]));
  let checked = 0;
  for (const span of spans) {
    const parts = span.split('='); if (parts.length < 2) continue;
    for (let i=1;i<parts.length;i++) {
      try { const a=scalar(parse(parts[i-1])),b=scalar(parse(parts[i])); checked++; if (!eq(a,b)) return evidence('fail','solution_calculation','A worked numeric equality is false.'); }
      catch (error) { if (error instanceof UndefinedMath) return evidence('fail','solution_calculation',error.message); }
    }
  }
  return evidence(checked ? 'pass':'inconclusive','solution_calculation',checked ? `${checked} explicit numeric equalities checked; other steps remain unproven.`:'No supported explicit numeric equality.');
}

export function verifySolutionForQuestion(question: unknown, solution: unknown): MathEvidence {
  const arithmetic = verifySolutionCalculations(solution);
  if (arithmetic.outcome === 'fail') return arithmetic;
  const text = mathText(question).replace(/[?.]\s*$/, '').trim();
  const original = text.match(/^Solve(?: for x)?\s+(.+)$/i);
  if (original) {
    try {
      const expected = roots(equation(original[1]));
      for (const span of String(solution ?? '').matchAll(/\$\$?([^$]+)\$\$?/g)) {
        if (!/x/.test(span[1]) || !/=/.test(span[1])) continue;
        try {
          const actual = roots(equation(mathText(span[1])));
          // Individual root branches are valid worked steps; they need not contain every root.
          if (!actual.every(a => expected.some(b => eq(a,b)))) return evidence('fail','solution_transformation','A worked equation introduces a root that does not solve the original equation.');
        } catch (error) { if (error instanceof UndefinedMath) return evidence('fail','solution_transformation',error.message); }
      }
    } catch { /* Unsupported transformations are not proof. */ }
  }
  return arithmetic;
}

/** Tolerance must come from a trusted caller, never a model's confidence or output. */
export function verifyNumericAnswer(expected: unknown, actual: unknown, absoluteTolerance: unknown = '0'): MathEvidence {
  try {
    const a=scalar(parse(expected)),b=scalar(parse(actual)),t=scalar(parse(absoluteTolerance));
    if (t.n < 0n) throw new Unsupported('Negative tolerance.');
    const difference=add(a,neg(b));
    const within=(difference.n < 0n ? -difference.n : difference.n)*t.d <= t.n*difference.d;
    return evidence(within?'pass':'fail','numerical_tolerance','Exact absolute-error comparison with caller-supplied tolerance.');
  } catch (error) { return evidence(error instanceof UndefinedMath?'fail':'inconclusive','numerical_tolerance',error instanceof Error?error.message:'Unsupported value.'); }
}
