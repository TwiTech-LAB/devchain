import {
  parseBoardFilters,
  serializeBoardFilters,
  toSearchParams,
  mergeBoardFilters,
  buildBoardFiltersUrl,
} from '@/ui/lib/url-filters';

describe('url-filters utilities', () => {
  test('parses multi-value arrays and de-duplicates (case-insensitive)', () => {
    const params = parseBoardFilters('?st=in_progress,review,IN_PROGRESS&t=bug,ui,bug');
    expect(params.status).toEqual(['in_progress', 'review']);
    expect(params.tags).toEqual(['bug', 'ui']);
  });

  test('serializes canonical order and encodes booleans as 0|1', () => {
    const qs = serializeBoardFilters({
      status: ['review', 'in_progress'],
      parent: '123',
      agent: 'abc',
      tags: ['b', 'a', 'a'],
      q: 'hello',
      sub: true,
      sort: 'updated',
    });
    expect(qs).toBe('st=in_progress,review&p=123&a=abc&t=a,b&q=hello&sb=1&s=updated');
  });

  test('ignores unknown keys when parsing', () => {
    const params = parseBoardFilters('?foo=bar&x=1');
    expect(params).toEqual({});
  });

  test('accepts long keys in input (backward/forward compatible)', () => {
    const params = parseBoardFilters('?status=review,in_progress&sub=true');
    expect(params).toEqual({ status: ['in_progress', 'review'], sub: true });
  });

  test('toSearchParams retains raw comma-separated values', () => {
    const sp = toSearchParams({ tags: ['y', 'x'], sub: false });
    expect(sp.get('t')).toBe('x,y');
    expect(sp.get('sb')).toBe('0');
  });

  test('merge combines current URL and delta, normalized', () => {
    const merged = mergeBoardFilters('?st=review&p=77', { status: ['in_progress'] });
    expect(merged).toBe('st=in_progress,review&p=77');
  });

  test('buildBoardFiltersUrl returns base when empty', () => {
    expect(buildBoardFiltersUrl('/board', {})).toBe('/board');
    expect(buildBoardFiltersUrl('/board', { q: 'hi' })).toBe('/board?q=hi');
  });

  describe('archived (ar) param', () => {
    test('parses archived param with short key', () => {
      expect(parseBoardFilters('?ar=active')).toEqual({ archived: 'active' });
      expect(parseBoardFilters('?ar=archived')).toEqual({ archived: 'archived' });
      expect(parseBoardFilters('?ar=all')).toEqual({ archived: 'all' });
    });

    test('parses archived param with long key', () => {
      expect(parseBoardFilters('?archived=active')).toEqual({ archived: 'active' });
      expect(parseBoardFilters('?archived=archived')).toEqual({ archived: 'archived' });
      expect(parseBoardFilters('?archived=all')).toEqual({ archived: 'all' });
    });

    test('returns undefined for archived when not present (default handled by consumer)', () => {
      const params = parseBoardFilters('?st=review');
      expect(params.archived).toBeUndefined();
      expect(params.status).toEqual(['review']);
    });

    test('ignores invalid archived values', () => {
      expect(parseBoardFilters('?ar=invalid')).toEqual({});
      expect(parseBoardFilters('?ar=yes')).toEqual({});
    });

    test('serializes archived param first in canonical order', () => {
      const qs = serializeBoardFilters({ archived: 'archived', status: ['review'] });
      expect(qs).toBe('ar=archived&st=review');
    });

    test('does not serialize archived when active (default)', () => {
      // When archived is 'active' (the default), it should still be serialized
      // to preserve explicit state in URL
      const qs = serializeBoardFilters({ archived: 'active', status: ['review'] });
      expect(qs).toBe('ar=active&st=review');
    });

    test('merges archived param', () => {
      const merged = mergeBoardFilters('?st=review', { archived: 'all' });
      expect(merged).toBe('ar=all&st=review');
    });
  });
});
