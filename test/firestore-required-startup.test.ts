import assert from 'node:assert/strict';
import test from 'node:test';
import { isFirestoreRequired } from '../src/store/db.ts';

test('Firestore-required startup flag is explicit and fail-safe', () => {
  const previous = process.env.REQUIRE_FIRESTORE;
  try {
    process.env.REQUIRE_FIRESTORE = 'true';
    assert.equal(isFirestoreRequired(), true);
    process.env.REQUIRE_FIRESTORE = 'false';
    assert.equal(isFirestoreRequired(), false);
  } finally {
    if (previous === undefined) delete process.env.REQUIRE_FIRESTORE;
    else process.env.REQUIRE_FIRESTORE = previous;
  }
});
