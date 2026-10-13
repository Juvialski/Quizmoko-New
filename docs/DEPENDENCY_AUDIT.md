# R1 dependency vulnerability classification

Local npm registry audit, 2026-10-13: 28 findings (1 critical / 17 high / 10 moderate) before, 11 (0 critical / 9 high / 2 moderate) after `npm audit fix --ignore-scripts` without `--force`. Counts include transitive parent findings and are not eleven distinct exploits. Existing package ranges are unchanged.

Compatible lockfile updates include proxy-addr 2.0.7 → 2.0.8, Engine.IO 6.6.9 → 6.6.11, PDF.js 6.1.200 → 6.4.299, sharp 0.35.3 → 0.35.5 and Express 4.22.2 → 4.22.3. Google Gen AI remains 2.13.0. Full regression/native PDF tests validate the updated lockfile; CI separately uses clean installation.

| Retained finding | Exposure / decision |
|---|---|
| gRPC, Firebase/Firestore parents (high) | Firebase web SDK pins gRPC 1.9.16. QuizMoKo uses Firestore clients, not the affected gRPC server authentication/context/status APIs. Retain compatible Firebase; npm suggests a breaking downgrade to Firebase 9.14.0. Revisit when upstream upgrades its pin. |
| braces, micromatch, fast-glob, globby, ejs-lint (high) | Development glob/lint chain; repository paths/patterns, not untrusted HTTP patterns. Retain tooling; suggested ejs-lint downgrade is incompatible. |
| uuid / ExcelJS (moderate) | UUID 8 transitive dependency. App does not call UUID with caller-provided destination buffers. Retain workbook compatibility instead of a breaking ExcelJS downgrade. |

Reviewed advisory IDs are fixed in `scripts/classify-dependency-audit.mjs`; new direct advisories, unknown packages and critical findings fail CI classification. Registry failure/malformed reports also fail. This classification is bounded exposure analysis, not an assertion that vulnerable dependencies are safe in every use.

References: [gRPC auth-context](https://github.com/advisories/GHSA-m9gg-hp2v-232j), [gRPC status disclosure](https://github.com/advisories/GHSA-f596-whhp-79r4), [braces recursion](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), [UUID buffer bounds](https://github.com/advisories/GHSA-w5hq-g745-h8pq), [proxy-addr fix](https://github.com/advisories/GHSA-jqcg-44mw-7w3h), [PDF.js fix](https://github.com/advisories/GHSA-hq66-cqwq-w95j).
