import { render, screen } from '@testing-library/react';
import { SubNavLayout } from './SubNavLayout';

describe('SubNavLayout', () => {
  it('separates the active content panel from the sub navigation rail', () => {
    render(
      <SubNavLayout
        sections={[
          { key: 'account', label: 'Account', render: () => <div>Account content</div> },
          { key: 'notifications', label: 'Notifications', render: () => <div>Notifications</div> },
        ]}
        activeKey="account"
        onSelect={jest.fn()}
        ariaLabel="Cloud navigation"
      />,
    );

    const content = screen.getByText('Account content').closest('[role="tabpanel"]');
    expect(content).toHaveClass('pt-4');
    expect(content).toHaveClass('lg:pl-6');
  });

  it('gives the active item the selected colors and marker, and hover only to inactive items', () => {
    render(
      <SubNavLayout
        sections={[
          { key: 'account', label: 'Account', render: () => <div>Account content</div> },
          { key: 'notifications', label: 'Notifications', render: () => <div>Notifications</div> },
        ]}
        activeKey="account"
        onSelect={jest.fn()}
      />,
    );

    const active = screen.getByRole('tab', { name: 'Account' });
    expect(active).toHaveAttribute('data-state', 'active');
    expect(active).toHaveClass(
      'relative',
      'data-[state=active]:bg-selected',
      'data-[state=active]:text-selected-foreground',
      'data-[state=active]:before:bg-primary',
      'data-[state=active]:before:w-[3px]',
      'data-[state=inactive]:hover:bg-muted',
    );
    expect(active).not.toHaveClass('data-[state=active]:bg-muted');
    expect(active).not.toHaveClass('hover:bg-muted');
  });
});
