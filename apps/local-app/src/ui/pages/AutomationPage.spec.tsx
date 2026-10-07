import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AutomationPage } from '@/ui/pages/AutomationPage';

jest.mock('@/ui/components/automation/WatchersTab', () => ({
  WatchersTab: () => <div>Watchers Content</div>,
}));

jest.mock('@/ui/components/automation/SubscribersTab', () => ({
  SubscribersTab: () => <div>Subscribers Content</div>,
}));

jest.mock('@/ui/components/automation/ScheduledEpicsTab', () => ({
  ScheduledEpicsTab: () => <div>Scheduled Epics Content</div>,
}));

describe('AutomationPage', () => {
  it('renders Watchers, Subscribers, and Scheduled Epics tab triggers', async () => {
    render(<AutomationPage />);
    expect(screen.getByRole('tab', { name: /watchers/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /subscribers/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /scheduled epics/i })).toBeInTheDocument();

    {
      expect(screen.getByText('Watchers Content')).toBeInTheDocument();
    }
    {
      expect(screen.getByRole('heading', { name: 'Automation' })).toBeInTheDocument();
    }
  });

  it.each([
    ['Scheduled Epics', 'Scheduled Epics Content'],
    ['Subscribers', 'Subscribers Content'],
  ])('opens %s tab content', async (tab, content) => {
    render(<AutomationPage />);
    await userEvent.click(screen.getByRole('tab', { name: tab }));
    expect(screen.getByText(content)).toBeInTheDocument();
  });
});
