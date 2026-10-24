# Worksheet progress and quiz editor hotfix — 2026-10-25

The worksheet solve action remains disabled through the existing owned job, displays actual completed/total counts and finalization inline, restores after Back/refresh, and exposes safe failure details plus Open Draft. Acknowledgment preserves the same idempotency identity. No new Gemini model, provider retry or database collection was added.

All editor cards are visible by default. The compact navigator scrolls; Needs Review optionally filters. Source numbers, diagrams, MathJax, advanced tools and local per-card input updates remain. Choice selectors resolve legacy keys before text changes, preserve selection identity and safely remap removal/shuffling. Any correctness edit invalidates previous single or batch approval.

Explicit save/draft intents retain unfinished question objects as private review-required drafts. Publication and legacy callers retain canonical validation. Publish errors identify printed question numbers and reasons; the editor links review blockers to their cards. Existing revision/version conflicts and acknowledged Firestore write/rollback are preserved. Saving does not call Gemini.

## Validation

- Full main-base regression: 183 tests passed. Build passed.
- Temporary PR #9 checkout with only the hotfix source/test patch applied: all 192 tests passed, including R4.2 lifecycle and durability protections. No PR #9 commits are included in this branch.
- Existing R4 and R4.1 isolated Chromium suites passed (mocked providers; actual app routes, PDF decoding, sockets and UI).
- New `scripts/test-worksheet-editor-browser.mjs`: one actual owned worksheet job, immediate disabled button, duplicate click guard, Back/refresh restoration, completion and draft action; 30 visible cards; all four choices edited; selection preserved without replacing the card; draft save/refresh; explicit approval and publish; blank/duplicate publication rejection; multi-select removal/shuffle mapping and later batch-approval invalidation. Finalization/error display includes synthetic status-event cases. See `worksheet-editor-browser.json`.
- Production public `/healthz` reported ready before release. No production quizzes, student results, credentials or Firestore configuration were changed during testing. Local persistence tests are not proof of a new production write.

The first hosted run passed application checks but correctly rejected new dependency advisories. Compatible lockfile-only patches update body-parser 1.20.8 → 1.20.9 and development undici 7.30.0 → 7.30.1; the classifier remains strict. See DEPENDENCY_AUDIT.md.

## Branch boundary

This hotfix branches from `main` at `0e21d9a`. PR #9 remains separate and is not merged or included. No new production persistence prerequisite or migration is introduced. Exact-head hosted CI is a separate release gate; production deployment/creative or live Gemini accuracy acceptance is not asserted by the local browser suite.
