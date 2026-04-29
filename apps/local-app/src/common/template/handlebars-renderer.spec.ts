import { renderTemplate } from './handlebars-renderer';

describe('renderTemplate', () => {
  it('substitutes basic variables', () => {
    expect(renderTemplate('Hello {{name}}!', { name: 'Alice' })).toBe('Hello Alice!');
  });

  it('resolves missing variables to empty string', () => {
    expect(renderTemplate('Hello {{name}}!', {})).toBe('Hello !');
  });

  describe('{{#if}} / {{else}}', () => {
    const tpl = '{{#if active}}yes{{else}}no{{/if}}';

    it('truthy path', () => {
      expect(renderTemplate(tpl, { active: true })).toBe('yes');
    });

    it('falsy path', () => {
      expect(renderTemplate(tpl, { active: false })).toBe('no');
    });
  });

  describe('{{#unless}}', () => {
    const tpl = '{{#unless disabled}}enabled{{/unless}}';

    it('renders when falsy', () => {
      expect(renderTemplate(tpl, { disabled: false })).toBe('enabled');
    });

    it('does not render when truthy', () => {
      expect(renderTemplate(tpl, { disabled: true })).toBe('');
    });
  });

  describe('boolean values with {{#if}}', () => {
    const tpl = '{{#if is_team_lead}}LEAD{{else}}MEMBER{{/if}}';

    it('boolean false evaluates as falsy', () => {
      expect(renderTemplate(tpl, { is_team_lead: false })).toBe('MEMBER');
    });

    it('boolean true evaluates as truthy', () => {
      expect(renderTemplate(tpl, { is_team_lead: true })).toBe('LEAD');
    });
  });

  it('noEscape: output contains literal HTML chars', () => {
    expect(renderTemplate('{{content}}', { content: '<b>bold</b> & "quoted"' })).toBe(
      '<b>bold</b> & "quoted"',
    );
  });

  describe('legacy preprocessor', () => {
    const legacy = ['name', 'agent_name', 'TITLE'];

    it('rewrites {name} in allowlist to {{name}}', () => {
      expect(renderTemplate('Hi {name}', { name: 'Bob' }, legacy)).toBe('Hi Bob');
    });

    it('preserves unknown {literal} tokens', () => {
      expect(renderTemplate('{unknown} text', {}, legacy)).toBe('{unknown} text');
    });

    it('leaves existing {{double}} braces untouched', () => {
      expect(renderTemplate('{{name}} and {name}', { name: 'X' }, legacy)).toBe('X and X');
    });

    it('strips ? suffix from optional legacy tokens', () => {
      expect(renderTemplate('Hi {name?}', { name: 'Eve' }, legacy)).toBe('Hi Eve');
    });

    it('matches case-insensitively', () => {
      expect(renderTemplate('{AGENT_NAME}', { agent_name: 'Bot' }, legacy)).toBe('Bot');
    });

    it('rewrites {TITLE} (uppercase allowlist entry) case-insensitively', () => {
      expect(renderTemplate('{title}', { title: 'Epic' }, legacy)).toBe('Epic');
    });
  });
});
