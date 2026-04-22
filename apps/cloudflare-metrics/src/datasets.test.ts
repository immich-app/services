import { describe, expect, it } from 'vitest';
import { ALL_DATASETS } from './datasets.js';

describe('dataset registry invariants', () => {
  it('every dataset defines at least one tag or field', () => {
    for (const dataset of ALL_DATASETS) {
      const fieldCount = Object.keys(dataset.fields).length;
      expect(fieldCount, `${dataset.key} must have fields`).toBeGreaterThan(0);
      for (const [, spec] of Object.entries(dataset.fields)) {
        expect(['int', 'float']).toContain(spec.type);
        expect(spec.source[0]).toMatch(/^(sum|avg|max|min|quantiles|uniq|_top)$/);
      }
    }
  });

  it('every dataset selects its timestamp dimension', () => {
    for (const dataset of ALL_DATASETS) {
      const timestampDim = dataset.timestampDimension ?? 'datetimeMinute';
      expect(dataset.dimensions, `${dataset.key} must include ${timestampDim}`).toContain(timestampDim);
    }
  });

  it('measurement names are unique and cf_-prefixed', () => {
    const seen = new Set<string>();
    for (const dataset of ALL_DATASETS) {
      expect(dataset.measurement).toMatch(/^cf_/);
      expect(seen.has(dataset.measurement)).toBe(false);
      seen.add(dataset.measurement);
    }
  });
});
