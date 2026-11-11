import { findMovedTextMarker, formatToolResultText, movedTextMarker } from './tool-result-text';
import { MOVED_TEXT_THRESHOLD_BYTES } from '../../../../common/constants/client-line-limits';

const long = (label: string) => `${label} line 1\n${'x'.repeat(MOVED_TEXT_THRESHOLD_BYTES)}\nend`;

function section(path: string, text: string): string {
  return `===== ${path} =====\n${text}\n===== end ${path} =====`;
}

describe('formatToolResultText', () => {
  it('keeps a result without long strings byte-identical to pretty JSON', () => {
    const data = {
      epic: {
        id: 'f08292f8',
        title: 'Short',
        createdAt: new Date('2026-11-09T00:00:00Z'),
        skipped: undefined,
        tags: ['a', 'b'],
        version: 2,
      },
      comments: [{ content: 'ok' }],
      total: null,
    };

    expect(formatToolResultText(data)).toBe(JSON.stringify(data, null, 2));
  });

  it.each([null, undefined, 'short', 3, []])('matches JSON.stringify for root %p', (root) => {
    expect(formatToolResultText(root)).toBe(JSON.stringify(root, null, 2));
  });

  it('moves long strings from nested objects, arrays and string arrays in path order', () => {
    const contentMd = long('sop');
    const comment = long('comment');
    const tag = long('tag');
    const data = {
      agent: { profile: { instructionsResolved: { contentMd, bytes: 10 } } },
      comments: [{ content: 'a' }, { content: 'b' }, { content: comment }],
      tags: ['short', tag],
    };
    const before = JSON.stringify(data);

    const text = formatToolResultText(data);

    const expectedJson = JSON.stringify(
      {
        agent: {
          profile: {
            instructionsResolved: {
              contentMd: movedTextMarker('agent.profile.instructionsResolved.contentMd'),
              bytes: 10,
            },
          },
        },
        comments: [
          { content: 'a' },
          { content: 'b' },
          { content: movedTextMarker('comments[2].content') },
        ],
        tags: ['short', movedTextMarker('tags[1]')],
      },
      null,
      2,
    );
    expect(text).toBe(
      [
        expectedJson,
        section('agent.profile.instructionsResolved.contentMd', contentMd),
        section('comments[2].content', comment),
        section('tags[1]', tag),
      ].join('\n'),
    );
    expect(JSON.stringify(data)).toBe(before);
  });

  it('handles a top-level array and a long root string', () => {
    const body = long('body');

    expect(formatToolResultText([{ body }])).toBe(
      [
        JSON.stringify([{ body: movedTextMarker('[0].body') }], null, 2),
        section('[0].body', body),
      ].join('\n'),
    );
    expect(formatToolResultText(body)).toBe(
      [JSON.stringify(movedTextMarker('(root)')), section('(root)', body)].join('\n'),
    );
  });

  it('quotes keys that are not identifiers', () => {
    const text = formatToolResultText({ 'my key': long('k'), "it's": long('q') });

    expect(text).toContain(`"my key": "${movedTextMarker("['my key']")}"`);
    expect(text).toContain(`===== end ['it\\'s'] =====`);
  });

  it.each([
    ['quotes', '"'],
    ['backslashes', '\\'],
    ['non-Latin text', 'ж'],
  ])('counts escaped UTF-8 bytes for a string full of %s', (_label, char) => {
    const value = char.repeat(MOVED_TEXT_THRESHOLD_BYTES / 2 + 1);
    const fitting = char.repeat(MOVED_TEXT_THRESHOLD_BYTES / 2 - 1);

    expect(value.length).toBeLessThan(MOVED_TEXT_THRESHOLD_BYTES);
    expect(formatToolResultText({ value })).toContain(movedTextMarker('value'));
    expect(formatToolResultText({ fitting })).toBe(JSON.stringify({ fitting }, null, 2));
  });

  it('moves a string just over the threshold and keeps one at the threshold', () => {
    // The escaped form adds two quote bytes.
    const atLimit = 'a'.repeat(MOVED_TEXT_THRESHOLD_BYTES - 2);
    const overLimit = 'a'.repeat(MOVED_TEXT_THRESHOLD_BYTES - 1);

    expect(formatToolResultText({ atLimit })).toBe(JSON.stringify({ atLimit }, null, 2));
    expect(formatToolResultText({ overLimit })).toContain(movedTextMarker('overLimit'));
  });
});

describe('findMovedTextMarker', () => {
  const marker = movedTextMarker('epic.description');

  it.each([
    ['the whole value', marker],
    ['a marker line with appended text', `${marker}\n\n## Added later\nmore text`],
    ['an indented marker line', `intro\r\n   ${marker}  \r\nrest`],
  ])('finds %s', (_label, description) => {
    expect(findMovedTextMarker({ sessionId: 's', description })).toEqual({
      argumentPath: ['description'],
      sectionPath: 'epic.description',
    });
  });

  it('reports nested argument paths', () => {
    expect(findMovedTextMarker({ descriptionEdits: [{ find: 'a', replace: marker }] })).toEqual({
      argumentPath: ['descriptionEdits', 0, 'replace'],
      sectionPath: 'epic.description',
    });
  });

  it.each([
    ['an inline mention', `Long text shows \`${marker}\` in the JSON.`],
    ['a marker with trailing words on its line', `${marker} and more`],
    ['plain text', 'no marker here'],
  ])('accepts %s', (_label, description) => {
    expect(findMovedTextMarker({ description, count: 3, flag: true, none: null })).toBeNull();
  });
});
