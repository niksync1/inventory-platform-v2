import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationId } from './operationId.ts';
test('creates a stable non-empty idempotency key', () => { assert.equal(createOperationId(123456, 0.5), 'mobile-2n9c-i'); });
