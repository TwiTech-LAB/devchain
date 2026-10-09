/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AppDownloadCard } from './AppDownloadCard';
import { APP_DOWNLOAD_LINKS } from '@/ui/lib/app-downloads';

// Mock QRCodeSVG: assert the `value` prop, never snapshot SVG internals.
jest.mock('qrcode.react', () => ({
  QRCodeSVG: ({
    value,
    bgColor,
    fgColor,
    includeMargin,
    marginSize,
  }: {
    value: string;
    bgColor?: string;
    fgColor?: string;
    includeMargin?: boolean;
    marginSize?: number;
  }) => (
    <div
      data-testid="qr-code-svg"
      data-value={value}
      data-bg-color={bgColor}
      data-fg-color={fgColor}
      data-include-margin={String(includeMargin)}
      data-margin-size={String(marginSize)}
    />
  ),
}));

const toastSpy = jest.fn();
jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastSpy }),
}));

const IOS_LABEL = 'Download from the App Store';
const ANDROID_LABEL = 'Download from Google Play';

function setClipboard(impl: { writeText?: jest.Mock } | undefined) {
  Object.defineProperty(navigator, 'clipboard', {
    value: impl,
    configurable: true,
    writable: true,
  });
}

describe('AppDownloadCard', () => {
  beforeEach(() => {
    toastSpy.mockReset();
    setClipboard({ writeText: jest.fn().mockResolvedValue(undefined) });
  });

  it('shows store buttons in the download card without premature QR output', () => {
    render(<AppDownloadCard />);
    {
      expect(screen.getByText('Get the DevChain mobile app')).toBeInTheDocument();
      expect(
        screen.getByText('Approve sign-ins and receive notifications on your phone.'),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: IOS_LABEL })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: ANDROID_LABEL })).toBeInTheDocument();
    }
    {
      const card = screen.getByTestId('app-download-card');
      expect(within(card).getByRole('button', { name: IOS_LABEL })).toBeInTheDocument();
      expect(within(card).getByRole('button', { name: ANDROID_LABEL })).toBeInTheDocument();
      expect(screen.queryByTestId('qr-code-svg')).not.toBeInTheDocument();
    }
  });

  it.each([
    { platform: 'ios', button: IOS_LABEL, store: 'App Store', url: APP_DOWNLOAD_LINKS.ios },
    {
      platform: 'android',
      button: ANDROID_LABEL,
      store: 'Google Play',
      url: APP_DOWNLOAD_LINKS.android,
    },
  ] as const)(
    'opens $platform download with QR and safe destination',
    async ({ platform, button, store, url }) => {
      render(<AppDownloadCard />);
      fireEvent.click(screen.getByRole('button', { name: button }));
      expect(await screen.findByText(`Download the app — ${store}`)).toBeInTheDocument();
      const qr = screen.getByTestId('qr-code-svg');
      expect(qr).toHaveAttribute('data-value', url);
      expect(qr).toHaveAttribute('data-bg-color', '#ffffff');
      expect(qr).toHaveAttribute('data-fg-color', '#000000');
      expect(qr).toHaveAttribute('data-margin-size', '4');
      const link = screen.getByTestId(`app-download-link-${platform}`);
      expect(link).toHaveAttribute('href', url);
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(link).toHaveTextContent(url);
      expect(link.className).toContain('break-all');
    },
  );

  it('copies the store URL and shows success feedback', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });

    render(<AppDownloadCard />);
    fireEvent.click(screen.getByRole('button', { name: IOS_LABEL }));
    await screen.findByText('Download the app — App Store');

    fireEvent.click(screen.getByTestId('app-download-copy-ios'));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(APP_DOWNLOAD_LINKS.ios);
      expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Link copied' }));
    });
  });

  it.each([
    {
      label: 'clipboard rejects',
      clipboard: { writeText: jest.fn().mockRejectedValue(new Error('denied')) },
      platform: 'android',
      button: ANDROID_LABEL,
      store: 'Google Play',
    },
    {
      label: 'clipboard absent',
      clipboard: undefined,
      platform: 'ios',
      button: IOS_LABEL,
      store: 'App Store',
    },
  ] as const)(
    'reports copy failure when $label',
    async ({ clipboard, platform, button, store }) => {
      setClipboard(clipboard);
      render(<AppDownloadCard />);
      fireEvent.click(screen.getByRole('button', { name: button }));
      await screen.findByText(`Download the app — ${store}`);
      fireEvent.click(screen.getByTestId(`app-download-copy-${platform}`));
      await waitFor(() =>
        expect(toastSpy).toHaveBeenCalledWith(
          expect.objectContaining({ variant: 'destructive', title: 'Could not copy link' }),
        ),
      );
    },
  );
});
