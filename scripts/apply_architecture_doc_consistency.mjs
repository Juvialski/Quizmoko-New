import fs from 'node:fs';

function replaceExact(path, before, after) {
  const content = fs.readFileSync(path, 'utf8');
  if (!content.includes(before)) throw new Error(`Expected documentation marker not found in ${path}`);
  fs.writeFileSync(path, content.replace(before, after));
}

const agentsPath = 'AGENTS.md';
replaceExact(
  agentsPath,
  '- Worksheet Source Identity: exact worksheet identifiers and natural source ordering are centralized in /src/services/worksheetSourceOrder.ts; do not derive source numbers from array positions.',
  '- Worksheet Source Identity: exact worksheet identifiers and natural source ordering are centralized in /src/services/worksheetSourceOrder.ts; do not derive source numbers from array positions.\n- Canonical Architecture Map: `docs/architecture/APP_WORKFLOW_MAP.md` is the human-readable current-state map and `docs/architecture/workflow-map.json` is its machine-readable companion. Read them before broad cross-subsystem work and update both whenever routes, views, services, persistent stores, access boundaries, or major workflows change.'
);
replaceExact(
  agentsPath,
  '- Stable Identity: Every extracted worksheet item must have a unique stable string ID retained through extraction, solving, review, publication, and provenance. Reject duplicate IDs and do not use array position as the semantic identity.',
  '- Source Identity: `original_index` is immutable printed metadata, not a globally unique database key. During extraction, preserve source provenance (`source_file`, page number, `original_index`, and stable source order) so repeated printed IDs on different pages/files are not silently collapsed. Preserve conflicting same-page duplicates for teacher review. Canonical quiz publication/recheck/golden-key maps still require unique question IDs; resolve/disambiguate those identities without rewriting the printed `original_index`. Never use array position as semantic source identity.'
);
replaceExact(
  agentsPath,
  '- Evolution Log: In addition to updating `AGENTS.md`, append a concise summary of the change, constraint, or learning to `AGENT_EVOLUTION_LOG.md` for historical tracking.',
  '- Evolution Log: In addition to updating `AGENTS.md`, append a concise summary of the change, constraint, or learning to `AGENT_EVOLUTION_LOG.md` for historical tracking.\n- Architecture Map Sync: Architectural changes are incomplete until both `docs/architecture/APP_WORKFLOW_MAP.md` and `docs/architecture/workflow-map.json` reflect the new current state.'
);

const evolutionPath = 'AGENT_EVOLUTION_LOG.md';
let evolution = fs.readFileSync(evolutionPath, 'utf8').trimEnd();
const evolutionEntry = '* **[2026-09-03]** Established the canonical full-application architecture baseline in `docs/architecture/APP_WORKFLOW_MAP.md` with machine-readable `docs/architecture/workflow-map.json`, verified against merged `main` commit `cedfb9bbef32c3400b0576b1f843451b448bfcef`. Clarified worksheet identity after the source-number preservation fix: printed `original_index` is immutable provenance and may repeat across different source locations, while publication/recheck/golden-key workflows still require unique canonical question identities. Future architectural changes must keep both map files synchronized.';
if (!evolution.includes('Established the canonical full-application architecture baseline')) {
  evolution += `\n${evolutionEntry}\n`;
  fs.writeFileSync(evolutionPath, evolution);
}

const reportPath = 'docs/IMPLEMENTATION_REPORT.md';
let report = fs.readFileSync(reportPath, 'utf8');
const historicalNote = '> **Historical document:** This report records the August 2026 AI-quality implementation pass. It is not the canonical current application architecture. Use `docs/architecture/APP_WORKFLOW_MAP.md` for the current full-app map.\n\n';
if (!report.includes('**Historical document:**')) {
  report = report.replace('# AI Quality Improvement Implementation Report\n\n', `# AI Quality Improvement Implementation Report\n\n${historicalNote}`);
  fs.writeFileSync(reportPath, report);
}
