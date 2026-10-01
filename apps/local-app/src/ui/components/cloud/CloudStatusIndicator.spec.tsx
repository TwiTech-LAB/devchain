import type { ReactElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CloudStatusIndicator } from './CloudStatusIndicator';

const mockUseCloudConnection = jest.fn();
jest.mock('../../hooks/useCloudConnection', () => ({
  useCloudConnection: () => mockUseCloudConnection(),
}));

const mockAccountMenuProps: { compact?: boolean; contextMenu?: ReactElement } = {};
jest.mock('./CloudAccountMenu', () => ({
  CloudAccountMenu: (props: { compact?: boolean; contextMenu?: ReactElement }) => {
    Object.assign(mockAccountMenuProps, props);
    return <div data-testid="cloud-account-menu" />;
  },
}));

jest.mock('./ProjectVmContextMenu', () => ({ ProjectVmContextMenu: () => null }));
const { ProjectVmContextMenu } = jest.requireMock('./ProjectVmContextMenu');

function renderIndicator(compact?: boolean) {
  return render(
    <MemoryRouter>
      <CloudStatusIndicator compact={compact} />
    </MemoryRouter>,
  );
}

describe('CloudStatusIndicator', () => {
  describe('signed-out', () => {
    beforeEach(() => {
      mockUseCloudConnection.mockReturnValue({
        status: { connected: false, identityServiceUrl: 'http://localhost:3002' },
        isLoading: false,
        disconnect: jest.fn(),
      });
    });

    it('renders a Link to /cloud?section=account with "Connect to cloud" text', () => {
      renderIndicator();
      const link = screen.getByRole('link', { name: /connect to cloud/i });
      expect(link).toHaveAttribute('href', '/cloud?section=account');
    });

    it('does not render any input or button labeled "Send magic link"', () => {
      renderIndicator();
      expect(screen.queryByRole('button', { name: /send magic link/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('does not render any button labeled "Sign in with GitHub"', () => {
      renderIndicator();
      expect(
        screen.queryByRole('button', { name: /sign in with github/i }),
      ).not.toBeInTheDocument();
    });

    it('does not render CloudAccountMenu', () => {
      renderIndicator();
      expect(screen.queryByTestId('cloud-account-menu')).not.toBeInTheDocument();
    });

    it('renders the CloudOff icon with aria-hidden="true"', () => {
      renderIndicator();
      // lucide-react renders SVGs; find the svg inside the link button
      const link = screen.getByRole('link', { name: /connect to cloud/i });
      const svg = link.querySelector('svg');
      expect(svg).toBeInTheDocument();
      expect(svg).toHaveAttribute('aria-hidden', 'true');
    });

    it('applies text-destructive class to the CloudOff icon', () => {
      renderIndicator();
      const link = screen.getByRole('link', { name: /connect to cloud/i });
      const svg = link.querySelector('svg');
      expect(svg).toHaveClass('text-destructive');
    });

    it('has no right-click menu', () => {
      renderIndicator();
      const link = screen.getByRole('link', { name: /connect to cloud/i });
      expect(fireEvent.contextMenu(link)).toBe(true);
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });

  describe('signed-in', () => {
    beforeEach(() => {
      mockUseCloudConnection.mockReturnValue({
        status: {
          connected: true,
          userId: 'user-123',
          email: 'test@example.com',
          identityServiceUrl: 'http://localhost:3002',
        },
        isLoading: false,
        disconnect: jest.fn(),
      });
    });

    it('renders CloudAccountMenu', () => {
      renderIndicator();
      expect(screen.getByTestId('cloud-account-menu')).toBeInTheDocument();
    });

    it('gives the account menu the project VM menu for a right click', () => {
      renderIndicator();
      expect(mockAccountMenuProps.contextMenu?.type).toBe(ProjectVmContextMenu);
    });

    it('does not render the connect link', () => {
      renderIndicator();
      expect(screen.queryByRole('link', { name: /connect to cloud/i })).not.toBeInTheDocument();
    });
  });

  describe('compact', () => {
    describe('connected', () => {
      beforeEach(() => {
        mockUseCloudConnection.mockReturnValue({
          status: {
            connected: true,
            userId: 'user-123',
            email: 'test@example.com',
            identityServiceUrl: 'http://localhost:3002',
          },
          isLoading: false,
          disconnect: jest.fn(),
        });
      });

      it('renders CloudAccountMenu with compact and the same right-click menu', () => {
        renderIndicator(true);
        expect(screen.getByTestId('cloud-account-menu')).toBeInTheDocument();
        expect(mockAccountMenuProps.compact).toBe(true);
        expect(mockAccountMenuProps.contextMenu?.type).toBe(ProjectVmContextMenu);
      });

      it('does not render the connect link', () => {
        renderIndicator(true);
        expect(screen.queryByRole('link', { name: /connect to cloud/i })).not.toBeInTheDocument();
      });
    });

    describe('signed-out', () => {
      beforeEach(() => {
        mockUseCloudConnection.mockReturnValue({
          status: { connected: false, identityServiceUrl: 'http://localhost:3002' },
          isLoading: false,
          disconnect: jest.fn(),
        });
      });

      it('renders an icon-only link to /cloud?section=account with a title', () => {
        renderIndicator(true);
        const link = screen.getByRole('link', { name: /connect to cloud/i });
        expect(link).toHaveAttribute('href', '/cloud?section=account');
        expect(link).toHaveAttribute('title', 'Connect to cloud');
        // Icon-only: the accessible name comes from aria-label, not rendered text.
        expect(link.textContent).toBe('');
      });

      it('keeps the CloudOff icon with text-destructive', () => {
        renderIndicator(true);
        const link = screen.getByRole('link', { name: /connect to cloud/i });
        const svg = link.querySelector('svg');
        expect(svg).toBeInTheDocument();
        expect(svg).toHaveAttribute('aria-hidden', 'true');
        expect(svg).toHaveClass('text-destructive');
      });
    });
  });

  describe('loading', () => {
    it('renders nothing when loading', () => {
      mockUseCloudConnection.mockReturnValue({
        status: { connected: false, identityServiceUrl: '' },
        isLoading: true,
        disconnect: jest.fn(),
      });
      const { container } = renderIndicator();
      expect(container.firstChild).toBeNull();
    });

    it('renders nothing when identityServiceUrl is missing', () => {
      mockUseCloudConnection.mockReturnValue({
        status: { connected: false, identityServiceUrl: '' },
        isLoading: false,
        disconnect: jest.fn(),
      });
      const { container } = renderIndicator();
      expect(container.firstChild).toBeNull();
    });
  });
});
