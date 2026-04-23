import { describe, expect, it } from 'vitest';

import {
  FILE_CONFLICT_VALUES,
  GRID_COLUMNS_VALUES,
  PREVIEW_POSITION_VALUES,
  SORT_BY_VALUES,
  SORT_ORDER_VALUES,
  THEME_VALUES,
  THUMBNAIL_QUALITY_VALUES,
  UPDATE_CHANNEL_VALUES,
} from '../constants';
import { INT_RANGE_MAPPINGS, SELECT_MAPPINGS, TOGGLE_MAPPINGS } from '../rendererSettingsMappings';

describe('rendererSettingsMappings', () => {
  it('defines non-empty mapping groups', () => {
    expect(TOGGLE_MAPPINGS.length).toBeGreaterThan(0);
    expect(SELECT_MAPPINGS.length).toBeGreaterThan(0);
    expect(INT_RANGE_MAPPINGS.length).toBeGreaterThan(0);
  });

  it('uses unique element ids across all mapping groups', () => {
    const ids = [
      ...TOGGLE_MAPPINGS.map(([id]) => id),
      ...SELECT_MAPPINGS.map(([id]) => id),
      ...INT_RANGE_MAPPINGS.map(([id]) => id),
    ];

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('maps select options to the expected constants', () => {
    const selectMap = new Map(SELECT_MAPPINGS.map(([id, key, values]) => [id, { key, values }]));

    expect(selectMap.get('theme-select')?.values).toEqual(THEME_VALUES);
    expect(selectMap.get('sort-by-select')?.values).toEqual(SORT_BY_VALUES);
    expect(selectMap.get('sort-order-select')?.values).toEqual(SORT_ORDER_VALUES);
    expect(selectMap.get('update-channel-select')?.values).toEqual(UPDATE_CHANNEL_VALUES);
    expect(selectMap.get('file-conflict-behavior-select')?.values).toEqual(FILE_CONFLICT_VALUES);
    expect(selectMap.get('thumbnail-quality-select')?.values).toEqual(THUMBNAIL_QUALITY_VALUES);
    expect(selectMap.get('preview-panel-position-select')?.values).toEqual(PREVIEW_POSITION_VALUES);
    expect(selectMap.get('grid-columns-select')?.values).toEqual(GRID_COLUMNS_VALUES);
  });

  it('declares valid integer input ranges', () => {
    for (const [, , min, max] of INT_RANGE_MAPPINGS) {
      expect(Number.isInteger(min)).toBe(true);
      expect(Number.isInteger(max)).toBe(true);
      expect(min).toBeGreaterThan(0);
      expect(max).toBeGreaterThanOrEqual(min);
    }
  });
});
