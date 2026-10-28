# Release integration evidence — 28 October 2026

Integration combines PRs #9, #13 and #14, preserving their commits. PRs #13 and #14 contain the same Archiver 8 constructor change; this branch retains one implementation and #14's workbook-content regression. Existing before/after screenshots are in `docs/ui-redesign-2026-10-25/` and `docs/audit-2026-10-28/`; new integration captures in this directory show synthetic desktop and mobile dashboard and live classroom views.

## Validation

- `npm ci`, `npm test`: 194 tests passed; `npm run build` passed.
- `npm run test:ui` and `npm run test:studio`: passed with isolated synthetic data. The R4.2 browser test exercises actual routes and sockets with mocked Gemini, including closing and replacing a run; Studio uses mocked extraction/provider boundaries and checks retained modes, navigation and actual ZIP/XLSX download.
- Dependency audit classifier passes after a bounded review of GHSA-6pq8-jhm2-2vcw; see `docs/DEPENDENCY_AUDIT.md`. Vulnerable qs remains installed pending a compatible upstream update.
- PR #14 records a real two-question Gemini generation on production, manually checked, on the same generation backend. This is a small sample, not general accuracy evidence or a test of the integrated release. Live extraction and a full real-provider integrated release journey remain unverified.

## Release gate

Do not merge while the deployed Firestore runtime identity and access to `live_runs` remain unverified. Read-only Render inspection on 28 October showed main auto-deploy, one instance, `npm start`, and live commit `494b656`. Logs identify service-account credentials for the expected Firebase project, but not the runtime principal or access to `live_runs`. Prior project IAM evidence is not proof of the running identity. Establish identity and read access using authorized runtime or equivalent principal-bound read-only tooling without exposing credentials; confirm required write permission through authorized IAM evidence. Keep startup fail-closed and do not create synthetic production runs. Also complete real extraction and teacher/student acceptance of the integrated release and review the UI screenshots before release.
