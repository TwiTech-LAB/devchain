import { renderTemplate } from './handlebars-renderer';

describe('renderTemplate', () => {
  it('substitutes basic variables', () => {
    expect(renderTemplate('Hello {{name}}!', { name: 'Alice' })).toBe('Hello Alice!');
  });

  it('resolves missing variables to empty string', () => {
    expect(renderTemplate('Hello {{name}}!', {})).toBe('Hello !');
  });

  it('noEscape: output contains literal HTML chars', () => {
    expect(renderTemplate('{{content}}', { content: '<b>bold</b> & "quoted"' })).toBe(
      '<b>bold</b> & "quoted"',
    );
  });

  describe('legacy preprocessor', () => {
    const legacy = ['name', 'agent_name', 'TITLE'];

    it.each([
      {
        label: 'rewrites {name} in allowlist to {{name}}',
        template: 'Hi {name}',
        vars: { name: 'Bob' },
        expected: 'Hi Bob',
      },
      {
        label: 'preserves unknown {literal} tokens',
        template: '{unknown} text',
        vars: {},
        expected: '{unknown} text',
      },
      {
        label: 'leaves existing {{double}} braces untouched',
        template: '{{name}} and {name}',
        vars: { name: 'X' },
        expected: 'X and X',
      },
      {
        label: 'strips ? suffix from optional legacy tokens',
        template: 'Hi {name?}',
        vars: { name: 'Eve' },
        expected: 'Hi Eve',
      },
      {
        label: 'matches case-insensitively',
        template: '{AGENT_NAME}',
        vars: { agent_name: 'Bot' },
        expected: 'Bot',
      },
      {
        label: 'rewrites {TITLE} (uppercase allowlist entry) case-insensitively',
        template: '{title}',
        vars: { title: 'Epic' },
        expected: 'Epic',
      },
    ])('$label', ({ template, vars, expected }) => {
      expect(renderTemplate(template, vars, legacy)).toBe(expected);
    });
  });
});
