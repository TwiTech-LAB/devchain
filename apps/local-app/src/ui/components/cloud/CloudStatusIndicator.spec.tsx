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

    it('shows the connect link without account or context menus', () => {
      renderIndicator();
      {
        const link = screen.getByRole('link', { name: /connect to cloud/i });
        expect(link).toHaveAttribute('href', '/cloud?section=account');
      }
      {
        expect(screen.queryByTestId('cloud-account-menu')).not.toBeInTheDocument();
      }
      {
        const link = screen.getByRole('link', { name: /connect to cloud/i });
        expect(fireEvent.contextMenu(link)).toBe(true);
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      }
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

    it('shows the account menu with the project VM context menu: renders CloudAccountMenu', () => {
      renderIndicator();
      {
        expect(screen.getByTestId('cloud-account-menu')).toBeInTheDocument();
      }
      {
        expect(mockAccountMenuProps.contextMenu?.type).toBe(ProjectVmContextMenu);
      }
      {
        expect(screen.queryByRole('link', { name: /connect to cloud/i })).not.toBeInTheDocument();
      }
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

      it('shows the account menu with the project VM context menu: renders CloudAccountMenu with compact and the same right-click menu', () => {
        renderIndicator(true);
        {
          expect(screen.getByTestId('cloud-account-menu')).toBeInTheDocument();
          expect(mockAccountMenuProps.compact).toBe(true);
          expect(mockAccountMenuProps.contextMenu?.type).toBe(ProjectVmContextMenu);
        }
        {
          expect(screen.queryByRole('link', { name: /connect to cloud/i })).not.toBeInTheDocument();
        }
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

      it('shows a compact accessible connect link', () => {
        renderIndicator(true);
        {
          const link = screen.getByRole('link', { name: /connect to cloud/i });
          expect(link).toHaveAttribute('href', '/cloud?section=account');
          expect(link).toHaveAttribute('title', 'Connect to cloud');
          expect(link.textContent).toBe('');
        }
        {
          const link = screen.getByRole('link', { name: /connect to cloud/i });
          const svg = link.querySelector('svg');
          expect(svg).toBeInTheDocument();
          expect(svg).toHaveAttribute('aria-hidden', 'true');
          expect(svg).toHaveClass('text-destructive');
        }
      });
    });
  });

  describe('loading', () => {
    it.each([
      { label: 'renders nothing when loading', isLoading: true },
      { label: 'renders nothing when identityServiceUrl is missing', isLoading: false },
    ] as const)('$label', ({ isLoading }) => {
      mockUseCloudConnection.mockReturnValue({
        status: { connected: false, identityServiceUrl: '' },
        isLoading: isLoading,
        disconnect: jest.fn(),
      });
      const { container } = renderIndicator();
      expect(container.firstChild).toBeNull();
    });
  });
});
