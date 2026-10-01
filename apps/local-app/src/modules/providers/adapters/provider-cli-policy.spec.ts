import { getProviderCliNoUpdateOptions } from './provider-cli-policy';

// Unit layer: policy merging is pure; a process cannot add coverage for these inputs.
describe('provider CLI update policy', () => {
  it('overrides inherited settings and retains valid inherited environment', () => {
    expect(
      getProviderCliNoUpdateOptions('CLAUDE', {
        PATH: '/bin',
        DISABLE_AUTOUPDATER: '0',
        MISSING: undefined,
        'invalid-key': 'value',
        MULTILINE: 'line1\nline2',
      }),
    ).toEqual({ env: { PATH: '/bin', DISABLE_AUTOUPDATER: '1' }, args: [] });
  });

  it('does not share mutable policy objects between commands', () => {
    getProviderCliNoUpdateOptions('codex').args.push('unexpected');
    getProviderCliNoUpdateOptions('claude').env.DISABLE_AUTOUPDATER = '0';
    expect(getProviderCliNoUpdateOptions('codex').args).toEqual([
      '-c',
      'check_for_update_on_startup=false',
    ]);
    expect(getProviderCliNoUpdateOptions('claude').env).toEqual({ DISABLE_AUTOUPDATER: '1' });
  });
});
