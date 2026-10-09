/**
 * Mobile-app download links + per-store presentation metadata for the
 * "Get the DevChain mobile app" CTA on Cloud Settings (`/cloud?section=account`).
 *
 * Both links are the public store listings: the App Store for iOS and
 * Google Play for Android.
 *
 * The QR codes encode the plain store URL (phone camera → opens the store listing).
 * No auth payloads are involved — this is NOT the QR sign-in flow.
 */

/** Store identifiers used as keys and test ids throughout the download CTA. */
export type AppStoreId = 'ios' | 'android';

/** Exact store URLs. Encoded in the QR and used as the direct anchor href. */
export const APP_DOWNLOAD_LINKS: Record<AppStoreId, string> = {
  ios: 'https://apps.apple.com/app/devchain/id6778791584',
  android: 'https://play.google.com/store/apps/details?id=com.twitech.devchain.mobile',
};

export interface AppDownloadStore {
  /** Stable identifier (`ios` | `android`). */
  id: AppStoreId;
  /** Primary platform label, e.g. "App Store". */
  label: string;
  /** Device line shown under the store name on the button, e.g. "iPhone". */
  channel: string;
  /** Explicit accessible name for the trigger button. */
  ariaLabel: string;
  /** Download-specific dialog title — must not be confusable with the QR sign-in dialog. */
  dialogTitle: string;
  /** Plain store URL (same value used for the QR and the direct link). */
  url: string;
}

/** Ordered store descriptors rendered by AppDownloadCard. */
export const APP_DOWNLOAD_STORES: readonly AppDownloadStore[] = [
  {
    id: 'ios',
    label: 'App Store',
    channel: 'iPhone',
    ariaLabel: 'Download from the App Store',
    dialogTitle: 'Download the app — App Store',
    url: APP_DOWNLOAD_LINKS.ios,
  },
  {
    id: 'android',
    label: 'Google Play',
    channel: 'Android',
    ariaLabel: 'Download from Google Play',
    dialogTitle: 'Download the app — Google Play',
    url: APP_DOWNLOAD_LINKS.android,
  },
];
