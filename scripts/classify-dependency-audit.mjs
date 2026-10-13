import fs from 'node:fs';
const report = JSON.parse(fs.readFileSync(process.argv[2] || 'audit.json', 'utf8'));
if (!report.vulnerabilities || report.error) throw new Error('Dependency audit unavailable or malformed.');
const classified = {
  '@grpc/grpc-js': 'Firebase web client pins a vulnerable gRPC dependency; app is a client, not a gRPC server. Do not downgrade Firebase.',
  '@firebase/firestore': 'Transitive Firebase gRPC advisory; see docs/DEPENDENCY_AUDIT.md.',
  '@firebase/firestore-compat': 'Transitive Firebase gRPC advisory.',
  firebase: 'Transitive Firebase gRPC advisory.',
  braces: 'Development-only EJS lint glob tooling; repository patterns only, no untrusted patterns.',
  micromatch: 'Development-only EJS lint glob tooling.',
  'fast-glob': 'Development-only EJS lint glob tooling.',
  globby: 'Development-only EJS lint glob tooling.',
  'ejs-lint': 'Development-only EJS lint glob tooling.',
  uuid: 'ExcelJS transitive UUID advisory; no caller-supplied output buffers in application.',
  exceljs: 'Transitive UUID advisory; retain workbook compatibility.'
};
const reviewedAdvisories = new Set([
  'https://github.com/advisories/GHSA-m9gg-hp2v-232j',
  'https://github.com/advisories/GHSA-f596-whhp-79r4',
  'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
  'https://github.com/advisories/GHSA-w5hq-g745-h8pq'
]);
let unclassified = false;
for (const [name, vulnerability] of Object.entries(report.vulnerabilities)) {
  const reason = classified[name];
  console.log(`${vulnerability.severity}: ${name}: ${reason || 'UNCLASSIFIED: review required'}`);
  if (!reason || vulnerability.severity === 'critical' || vulnerability.via.some(v => typeof v === 'object' && !reviewedAdvisories.has(v.url))) unclassified = true;
}
if (unclassified) process.exitCode = 1;
