import assert from 'node:assert/strict';
import test from 'node:test';
import { escapeLikePattern, mergeUniqueById, normalizeProductSearch } from './search.ts';
test('normalizes bounded product search text', () => { assert.equal(normalizeProductSearch('  paracetamol   500mg '), 'paracetamol 500mg'); assert.equal(normalizeProductSearch('x'.repeat(100)).length, 80); });
test('escapes SQL LIKE wildcard characters', () => { assert.equal(escapeLikePattern('50%_off\\sale'), '50\\%\\_off\\\\sale'); });
test('merges search results without duplicate products', () => { assert.deepEqual(mergeUniqueById([{ id: 'a', name: 'A' }], [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]).map(item => item.id), ['a', 'b']); });
