import {
  MIN_HOST_IMAGE_VERSION,
  isSupportedHostImage,
  unsupportedHostImageMessage,
} from './host-image';

describe('host image version gate', () => {
  it.each(['1.3.0', '1.3.0-lan.202610010000', '1.3.1', '2.0.0-lan.1'])('accepts %s', (version) => {
    expect(isSupportedHostImage(version)).toBe(true);
  });

  it.each(['1.2.0', '1.2.0-lan.202609300112', '0.2.0', 'not-a-version', null, undefined, ''])(
    'refuses %p',
    (version) => {
      expect(isSupportedHostImage(version)).toBe(false);
    },
  );

  it('names the minimum without a prerelease suffix', () => {
    expect(MIN_HOST_IMAGE_VERSION).toBe('1.3.0');
    expect(unsupportedHostImageMessage('1.2.0')).toBe(
      'Host image 1.2.0 is not supported; 1.3.0 or later is needed.',
    );
  });
});
