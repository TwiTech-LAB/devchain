import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CloudStatusIndicator } from './CloudStatusIndicator';

const mockUseCloudConnection = jest.fn();
jest.mock('../../hooks/useCloudConnection', () => ({
  useCloudConnection: () => mockUseCloudConnection(),
}));

jest.mock('./CloudAccountMenu', () => ({
  CloudAccountMenu: () => <div data-testid="cloud-account-menu" />,
}));

function renderIndicator() {
  return render(
    <MemoryRouter>
      <CloudStatusIndicator />
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

    it('does not render the connect link', () => {
      renderIndicator();
      expect(screen.queryByRole('link', { name: /connect to cloud/i })).not.toBeInTheDocument();
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
