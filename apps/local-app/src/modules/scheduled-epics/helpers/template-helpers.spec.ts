import { checkTemplateReady } from './template-helpers';

describe('checkTemplateReady', () => {
  it('returns ready for a plain string template', () => {
    expect(checkTemplateReady('Hello world')).toEqual({ ready: true });
  });

  it('returns ready when sample vars satisfy the template', () => {
    const result = checkTemplateReady('Task: {{title}}', { title: 'Deploy' });
    expect(result).toEqual({ ready: true });
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
