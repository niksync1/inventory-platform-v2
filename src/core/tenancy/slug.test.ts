import assert from 'node:assert/strict';
import test from 'node:test';
import { tenantSlug } from './slug.ts';
test('creates a stable tenant slug', () => { assert.equal(tenantSlug('  Élévé Health Watch  '), 'eleve-health-watch'); assert.equal(tenantSlug('---'), ''); });
