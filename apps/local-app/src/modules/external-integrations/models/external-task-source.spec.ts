import { normalizeExternalTaskSourceUrl } from './external-task-source';

describe('normalizeExternalTaskSourceUrl', () => {
  it.each([
    ['clickup' as const, 'https://app.clickup.com/t/abc', 'https://app.clickup.com/t/abc'],
    [
      'jira' as const,
      'https://acme.atlassian.net/browse/ENG-1',
      'https://acme.atlassian.net/browse/ENG-1',
    ],
    ['clickup' as const, 'javascript:alert(1)', null],
    ['clickup' as const, 'https://evil.example/t/abc', null],
    ['jira' as const, 'https://acme.atlassian.net.evil.example/browse/ENG-1', null],
  ])('normalizes %s source %s', (provider, value, expected) => {
    expect(normalizeExternalTaskSourceUrl(provider, value)).toBe(expected);
  });
});
