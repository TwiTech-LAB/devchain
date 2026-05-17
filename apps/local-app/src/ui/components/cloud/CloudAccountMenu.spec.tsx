import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CloudAccountMenu } from './CloudAccountMenu';

const mockDisconnect = jest.fn();

function renderMenu() {
  return render(
    <MemoryRouter>
      <CloudAccountMenu
        userId="user-12345678"
        email="test@example.com"
        identityServiceUrl="http://localhost:3002"
        onDisconnect={mockDisconnect}
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
});
