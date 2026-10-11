/** @jest-environment jsdom */

import {
  CLOUD_SIGN_IN_NONCE_STORAGE_KEY,
  createCloudSignInCallbackUrl,
  openCloudOAuthPopup,
} from './cloud-target';

// jsdom exercises the shared browser storage and URL contract without an OAuth server.
describe('cloud sign-in callback URL', () => {
  beforeEach(() => {
    window.localStorage.clear();
    jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([true, false])('stores a 128-bit nonce with randomUUID available: %s', (available) => {
    const randomUUID = Object.getOwnPropertyDescriptor(window.crypto, 'randomUUID');
    Object.defineProperty(window.crypto, 'randomUUID', {
      configurable: true,
      value: available ? jest.fn() : undefined,
    });
    const getRandomValues = jest.spyOn(window.crypto, 'getRandomValues');

    try {
      const callback = new URL(createCloudSignInCallbackUrl());
      const nonce = callback.searchParams.get('nonce');

      expect(callback.origin).toBe(window.location.origin);
      expect(callback.pathname).toBe('/auth/cloud/callback');
      expect(nonce).toMatch(/^[0-9a-f]{32}$/);
      expect(getRandomValues).toHaveBeenCalledWith(expect.any(Uint8Array));
      expect(getRandomValues.mock.calls[0][0]?.byteLength).toBe(16);
      expect(window.localStorage.getItem(CLOUD_SIGN_IN_NONCE_STORAGE_KEY)).toBe(
        JSON.stringify({ nonce, createdAt: Date.now() }),
      );
      if (available) expect(window.crypto.randomUUID).not.toHaveBeenCalled();
    } finally {
      if (randomUUID) Object.defineProperty(window.crypto, 'randomUUID', randomUUID);
      else Reflect.deleteProperty(window.crypto, 'randomUUID');
    }
  });

  it('replaces a previous sign-in nonce', () => {
    window.localStorage.setItem(
      CLOUD_SIGN_IN_NONCE_STORAGE_KEY,
      JSON.stringify({ nonce: 'previous', createdAt: 0 }),
    );

    const callback = new URL(createCloudSignInCallbackUrl());

    expect(JSON.parse(window.localStorage.getItem(CLOUD_SIGN_IN_NONCE_STORAGE_KEY)!)).toEqual({
      nonce: callback.searchParams.get('nonce'),
      createdAt: Date.now(),
    });
  });

  it('includes the stored nonce in the OAuth popup redirect', () => {
    const open = jest.spyOn(window, 'open').mockReturnValue(null);

    openCloudOAuthPopup('https://identity.example.com', { backend: 'home', remoteName: null });

    const popup = new URL(open.mock.calls[0][0] as string);
    const callback = new URL(popup.searchParams.get('redirect_uri')!);
    const stored = JSON.parse(window.localStorage.getItem(CLOUD_SIGN_IN_NONCE_STORAGE_KEY)!);
    expect(callback.searchParams.get('nonce')).toBe(stored.nonce);
  });

  it('refuses to start OAuth when the nonce cannot be stored', () => {
    const open = jest.spyOn(window, 'open').mockReturnValue(null);
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage unavailable');
    });

    expect(() =>
      openCloudOAuthPopup('https://identity.example.com', { backend: 'home', remoteName: null }),
    ).toThrow('Storage unavailable');
    expect(open).not.toHaveBeenCalled();
  });
});
