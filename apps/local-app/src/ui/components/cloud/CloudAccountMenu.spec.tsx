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

  it('renders the trigger button with email', () => {
    renderMenu();
    expect(screen.getByRole('button')).toHaveTextContent('test@example.com');
  });

  it('shows "Manage cloud account" as the first menu item linking to /cloud?section=account', async () => {
    renderMenu();
    await openDropdown();

    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items[0]).toHaveTextContent('Manage cloud account');
    // With asChild, the Link IS the menuitem element
    expect(items[0]).toHaveAttribute('href', '/cloud?section=account');
  });

  it('navigates via react-router Link (no window.location change)', async () => {
    renderMenu();
    await openDropdown();

    // The first menuitem is an <a> tag rendered by react-router Link
    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items[0].tagName).toBe('A');
    expect(items[0].getAttribute('href')).toBe('/cloud?section=account');
  });

  it('renders Switch account and Disconnect after the manage link', async () => {
    renderMenu();
    await openDropdown();

    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Manage cloud account');
    expect(items[1]).toHaveTextContent('Switch account');
    expect(items[2]).toHaveTextContent('Disconnect');
  });

  it('separator exists between Manage cloud account and Switch account', async () => {
    renderMenu();
    await openDropdown();

    const menu = screen.getByRole('menu');
    // Radix separators have role="separator"
    const separators = within(menu).getAllByRole('separator');
    expect(separators.length).toBeGreaterThanOrEqual(1);
  });

  describe('compact', () => {
    it('renders an icon-only trigger whose accessible name carries the email', () => {
      renderMenu(true);
      const trigger = screen.getByRole('button', { name: 'Cloud connected: test@example.com' });
      expect(trigger).toHaveTextContent('');
      expect(trigger.querySelector('svg')).toBeInTheDocument();
    });

    it('still shows the email inside the dropdown', async () => {
      renderMenu(true);
      await userEvent.click(screen.getByRole('button'));

      const menu = screen.getByRole('menu');
      expect(menu).toHaveTextContent('test@example.com');
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
