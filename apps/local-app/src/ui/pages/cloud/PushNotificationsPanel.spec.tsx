import { render, screen } from '@testing-library/react';
import { PushNotificationsPanel } from './PushNotificationsPanel';

jest.mock('@/ui/components/cloud/DevicesPanel', () => ({
  DevicesPanel: () => <div data-testid="devices-panel">devices</div>,
}));

jest.mock('@/ui/components/cloud/NotificationPreferencesPanel', () => ({
  NotificationPreferencesPanel: () => (
    <div data-testid="notification-preferences-panel">preferences</div>
  ),
}));

jest.mock('@/ui/components/cloud/QuietHoursConfig', () => ({
  QuietHoursConfig: () => <div data-testid="quiet-hours-config">quiet</div>,
}));

jest.mock('@/ui/components/cloud/ProjectForwardingList', () => ({
  ProjectForwardingList: () => <div data-testid="project-forwarding-list">forwarding</div>,
}));

describe('PushNotificationsPanel', () => {
  it('renders the redesigned two-column content hierarchy', () => {
    const { container } = render(<PushNotificationsPanel />);

    expect(screen.getByRole('heading', { name: 'Push Notifications' })).toBeInTheDocument();
    expect(screen.getByTestId('devices-panel')).toBeInTheDocument();
    expect(screen.getByTestId('notification-preferences-panel')).toBeInTheDocument();
    expect(screen.getByTestId('quiet-hours-config')).toBeInTheDocument();
    expect(screen.getByTestId('project-forwarding-list')).toBeInTheDocument();

    const grid = container.querySelector('div.grid.gap-6.lg\\:grid-cols-2');
    expect(grid).toBeInTheDocument();
  });
});
