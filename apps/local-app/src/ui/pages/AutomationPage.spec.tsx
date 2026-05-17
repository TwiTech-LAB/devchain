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
  it('renders Watchers, Subscribers, and Scheduled Epics tab triggers', () => {
    render(<AutomationPage />);
    expect(screen.getByRole('tab', { name: /watchers/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /subscribers/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /scheduled epics/i })).toBeInTheDocument();
  });

  it('defaults to the Watchers tab', () => {
    render(<AutomationPage />);
    expect(screen.getByText('Watchers Content')).toBeInTheDocument();
  });

  it('shows Scheduled Epics content when Scheduled Epics tab is clicked', async () => {
    render(<AutomationPage />);
    await userEvent.click(screen.getByRole('tab', { name: /scheduled epics/i }));
    expect(screen.getByText('Scheduled Epics Content')).toBeInTheDocument();
  });

  it('shows Subscribers content when Subscribers tab is clicked', async () => {
    render(<AutomationPage />);
    await userEvent.click(screen.getByRole('tab', { name: /subscribers/i }));
    expect(screen.getByText('Subscribers Content')).toBeInTheDocument();
  });

  it('renders the Automation heading', () => {
    render(<AutomationPage />);
    expect(screen.getByRole('heading', { name: 'Automation' })).toBeInTheDocument();
  });
});
