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
});
