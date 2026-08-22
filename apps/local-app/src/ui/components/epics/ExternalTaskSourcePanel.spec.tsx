import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { ExternalTaskSourcePanel } from './ExternalTaskSourcePanel';

describe('ExternalTaskSourcePanel', () => {
  it('renders remote fields as text and exposes only provider-allowlisted source URLs', async () => {
    const { baseElement, container } = render(
      <ExternalTaskSourcePanel
        items={[
          {
            provider: 'jira',
            remoteTaskId: 'ENG-1',
            remoteKey: 'ENG-1',
            title: '<script>alert(1)</script>',
            workAreaName: '<img src=x>',
            statusName: 'In Progress',
            webUrl: 'https://acme.atlassian.net/browse/ENG-1',
            linkedAt: '2026-08-19T10:00:00.000Z',
          },
          {
            provider: 'clickup',
            remoteTaskId: 'bad',
            remoteKey: 'bad',
            title: 'Unsafe link',
            workAreaName: 'List',
            statusName: 'OPEN',
            webUrl: 'javascript:alert(1)',
            linkedAt: '2026-08-19T10:00:00.000Z',
          },
        ]}
      />,
    );

    expect(baseElement.querySelector('script')).toBeNull();
    expect(baseElement.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: 'Open source task' })).toHaveAttribute(
      'href',
      'https://acme.atlassian.net/browse/ENG-1',
    );
    expect(screen.getByText('Source link unavailable')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});
