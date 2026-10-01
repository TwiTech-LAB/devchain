import { addressHost, addressOrigin, installerUrl, nothingSentence } from './own-vm-address';

describe('own VM address', () => {
  it.each([
    ['192.168.1.50', 'https://192.168.1.50'],
    ['192.168.1.50:4000', 'https://192.168.1.50:4000'],
    ['https://vm.lan:8443', 'https://vm.lan:8443'],
    [' vm.lan ', 'https://vm.lan'],
    ['[fd00::5]:4000', 'https://[fd00::5]:4000'],
  ])('reads %s as %s', (address, origin) => {
    expect(addressOrigin(address)).toBe(origin);
  });

  it.each(['', '192.168.1.50/path', 'ftp://vm.lan'])('names no origin for %j', (address) => {
    expect(addressOrigin(address)).toBeNull();
    expect(installerUrl(address)).toBeNull();
  });

  it('refuses an explicit http:// address', () => {
    expect(addressOrigin('http://192.168.1.50:4000')).toBeNull();
    expect(addressOrigin('http://vm.lan')).toBeNull();
    expect(addressHost('http://vm.lan')).toBeNull();
    expect(installerUrl('http://vm.lan:3000')).toBeNull();
  });

  it("checks the installer's port whatever port was typed", () => {
    expect(installerUrl('192.168.1.50:4000')).toBe('https://192.168.1.50:3000');
    expect(installerUrl('https://vm.lan:8443')).toBe('https://vm.lan:3000');
    expect(addressHost('[fd00::5]:4000')).toBe('[fd00::5]');
  });

  it('names every place that did not answer, SSH included', () => {
    expect(
      nothingSentence({
        kind: 'nothing',
        tried: ['https://192.168.1.50:3000', 'https://192.168.1.50:4000'],
        sshReachable: false,
      }),
    ).toBe(
      'Nothing answers at 192.168.1.50:3000, at 192.168.1.50:4000, or on SSH port 22. Check the address and the firewall.',
    );
    expect(
      nothingSentence({ kind: 'nothing', tried: ['https://vm.lan:4000'], sshReachable: false }),
    ).toBe('Nothing answers at vm.lan:4000 or on SSH port 22. Check the address and the firewall.');
  });

  it('leaves SSH out when it answers or was not checked', () => {
    const tried = ['https://192.168.1.50:3000', 'https://192.168.1.50:4000'];
    expect(nothingSentence({ kind: 'nothing', tried, sshReachable: true })).toBe(
      'No DevChain and no installer answers at 192.168.1.50:3000 or at 192.168.1.50:4000.',
    );
    expect(nothingSentence({ kind: 'nothing', tried: tried.slice(1), sshReachable: null })).toBe(
      'No DevChain and no installer answers at 192.168.1.50:4000.',
    );
  });
});
