import { ValidationError } from '../../../common/errors/error-types';
import { assertSupportedOpencodeVersion, parseOpencodeCliVersion } from './opencode-cli-version';

describe('opencode CLI version', () => {
  it.each([
    ['1.18.32', 1],
    ['opencode v2.0.31\n', 2],
  ])('parses %j as major %i', (raw, major) => {
    expect(parseOpencodeCliVersion(raw)).toEqual({ raw: raw.trim(), major });
    expect(assertSupportedOpencodeVersion(raw, '/bin/opencode').major).toBe(major);
  });

  it.each(['garbage', '', '3.0.1', 'opencode v0.9.0'])('rejects %j', (raw) => {
    const call = () => assertSupportedOpencodeVersion(raw, '/bin/opencode');
    expect(call).toThrow(ValidationError);
    expect(call).toThrow(
      `Unsupported OpenCode version '${raw}' at /bin/opencode. DevChain supports OpenCode 1.x and 2.x.`,
    );
  });
});
