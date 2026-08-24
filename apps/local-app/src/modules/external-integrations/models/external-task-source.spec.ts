import {
  normalizeExternalProviderSourceUrl,
  normalizeExternalTaskSourceUrl,
  normalizeExternalWorkAreaSourceUrl,
} from './external-task-source';

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

describe('normalizeExternalWorkAreaSourceUrl', () => {
  it.each([
    [
      'clickup' as const,
      'https://app.clickup.com/workspace-1/v/li/list-1',
      'https://app.clickup.com/workspace-1/v/li/list-1',
    ],
    [
      'jira' as const,
      'https://acme.atlassian.net/secure/RapidBoard.jspa?rapidView=42',
      'https://acme.atlassian.net/secure/RapidBoard.jspa?rapidView=42',
    ],
    ['clickup' as const, 'https://evil.example/workspace-1/v/li/list-1', null],
    ['clickup' as const, 'https://app.clickup.com/t/task-1', null],
    [
      'jira' as const,
      'https://acme.atlassian.net.evil.example/secure/RapidBoard.jspa?rapidView=42',
      null,
    ],
    ['jira' as const, 'https://acme.atlassian.net/secure/RapidBoard.jspa?rapidView=', null],
  ])('normalizes %s work-area source %s', (provider, value, expected) => {
    expect(normalizeExternalWorkAreaSourceUrl(provider, value)).toBe(expected);
  });
});

describe('normalizeExternalProviderSourceUrl', () => {
  it.each([
    ['clickup' as const, 'https://app.clickup.com', 'https://app.clickup.com/'],
    ['jira' as const, 'https://acme.atlassian.net', 'https://acme.atlassian.net/'],
    ['clickup' as const, 'https://evil.example', null],
    ['clickup' as const, 'https://app.clickup.com/t/task-1', null],
    ['jira' as const, 'https://acme.atlassian.net.evil.example', null],
    ['jira' as const, 'https://acme.atlassian.net/?redirect=evil', null],
  ])('normalizes %s provider source %s', (provider, value, expected) => {
    expect(normalizeExternalProviderSourceUrl(provider, value)).toBe(expected);
  });
});
