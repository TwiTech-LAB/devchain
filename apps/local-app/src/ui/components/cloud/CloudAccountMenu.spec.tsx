import type { ReactNode } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ContextMenuItem } from '../ui/context-menu';
import { CloudAccountMenu } from './CloudAccountMenu';

const mockDisconnect = jest.fn();

function renderMenu(compact?: boolean, contextMenu?: ReactNode) {
  return render(
    <MemoryRouter>
      <CloudAccountMenu
        userId="user-12345678"
        email="test@example.com"
        identityServiceUrl="http://localhost:3002"
        onDisconnect={mockDisconnect}
        compact={compact}
        contextMenu={contextMenu}
      />
    </MemoryRouter>,
  );
}

function openDropdown() {
  return userEvent.click(screen.getByRole('button'));
}

describe('CloudAccountMenu', () => {
  beforeEach(() => {
    mockDisconnect.mockClear();
  });

  it('shows the account trigger, manage link and ordered switch/disconnect items', async () => {
    renderMenu();
    expect(screen.getByRole('button')).toHaveTextContent('test@example.com');
    await openDropdown();
    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items[0]).toHaveTextContent('Manage cloud account');
    expect(items[0]).toHaveAttribute('href', '/cloud?section=account');
    {
      const menu = screen.getByRole('menu');
      const items = within(menu).getAllByRole('menuitem');
      expect(items[0].tagName).toBe('A');
      expect(items[0].getAttribute('href')).toBe('/cloud?section=account');
    }
    {
      const menu = screen.getByRole('menu');
      const items = within(menu).getAllByRole('menuitem');
      expect(items).toHaveLength(3);
      expect(items[0]).toHaveTextContent('Manage cloud account');
      expect(items[1]).toHaveTextContent('Switch account');
      expect(items[2]).toHaveTextContent('Disconnect');
    }
  });

  describe('compact', () => {
    it('shows an icon-only account trigger and email in its menu', async () => {
      renderMenu(true);
      {
        const trigger = screen.getByRole('button', { name: 'Cloud connected: test@example.com' });
        expect(trigger).toHaveTextContent('');
        expect(trigger.querySelector('svg')).toBeInTheDocument();
        await userEvent.click(trigger);
        expect(screen.getByRole('menu')).toHaveTextContent('test@example.com');
      }
    });
  });

  describe('right-click menu', () => {
    const projectItems = <ContextMenuItem>Project item</ContextMenuItem>;

    it('opens the given items on a right click instead of the browser menu', () => {
      renderMenu(false, projectItems);
      const notPrevented = fireEvent.contextMenu(screen.getByRole('button'));

      expect(notPrevented).toBe(false);
      const menu = screen.getByRole('menu');
      expect(within(menu).getByRole('menuitem', { name: 'Project item' })).toBeInTheDocument();
      expect(within(menu).queryByText('Manage cloud account')).not.toBeInTheDocument();
    });

    it('keeps the account menu on a left click, with the trigger state following it', async () => {
      renderMenu(true, projectItems);
      const trigger = screen.getByRole('button', { name: 'Cloud connected: test@example.com' });
      expect(trigger).toHaveAttribute('data-state', 'closed');

      await openDropdown();

      expect(trigger).toHaveAttribute('data-state', 'open');
      const menu = screen.getByRole('menu');
      expect(within(menu).getAllByRole('menuitem')[0]).toHaveTextContent('Manage cloud account');
      expect(screen.queryByText('Project item')).not.toBeInTheDocument();
    });

    it('leaves the browser menu alone without items', () => {
      renderMenu();
      expect(fireEvent.contextMenu(screen.getByRole('button'))).toBe(true);
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });
});
