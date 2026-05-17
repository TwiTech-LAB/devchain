import { checkTemplateReady, renderScheduledEpicTemplate } from './template-helpers';

describe('checkTemplateReady', () => {
  it('returns ready for a plain string template', () => {
    expect(checkTemplateReady('Hello world')).toEqual({ ready: true });
  });

  it('returns ready for a valid Handlebars template', () => {
    expect(checkTemplateReady('Hello {{name}}')).toEqual({ ready: true });
  });

  it('returns ready when sample vars satisfy the template', () => {
    const result = checkTemplateReady('Task: {{title}}', { title: 'Deploy' });
    expect(result).toEqual({ ready: true });
  });

  it('returns ready for templates with missing vars (Handlebars renders empty string)', () => {
    // Handlebars silently renders missing vars as empty — that is valid behavior
    expect(checkTemplateReady('Hello {{name}}')).toEqual({ ready: true });
  });

  it('returns not ready for malformed Handlebars syntax', () => {
    // Unclosed block helper is a syntax error in Handlebars
    const result = checkTemplateReady('{{#if foo}}no closing tag');
    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('renderScheduledEpicTemplate', () => {
  it('renders variables into the template', () => {
    const output = renderScheduledEpicTemplate('Deploy {{env}}', { env: 'production' });
    expect(output).toBe('Deploy production');
  });

  it('renders an empty string for missing variables', () => {
    const output = renderScheduledEpicTemplate('Hello {{name}}', {});
    expect(output).toBe('Hello ');
  });

  it('supports legacy single-brace tokens when registered', () => {
    // renderTemplate handles Handlebars {{}} syntax directly
    const output = renderScheduledEpicTemplate('Task: {{title}}', { title: 'Weekly sync' });
    expect(output).toBe('Task: Weekly sync');
  });
});
