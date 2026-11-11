/**
 * Which socket peers count as this machine. Unit layer: the rule is a pure function of
 * the socket's two addresses; the route spec checks the guard is wired to the route.
 */
import { isLocalPeer } from './vault-local-peer.guard';

describe('isLocalPeer', () => {
  it.each([
    ['IPv4 loopback', '127.0.0.1', '127.0.0.1', true],
    ['another IPv4 loopback address', '127.0.0.2', '127.0.0.1', true],
    ['IPv6 loopback', '::1', '::1', true],
    ['IPv4-mapped loopback', '::ffff:127.0.0.1', '::ffff:127.0.0.1', true],
    ['self-call on a NIC bind', '192.168.1.20', '192.168.1.20', true],
    ['self-call on a NIC bind, mapped on one side', '::ffff:192.168.1.20', '192.168.1.20', true],
    ['self-call on an IPv6 NIC bind', 'fe80::1', 'FE80::1', true],
    ['another machine on the LAN', '192.168.1.30', '192.168.1.20', false],
    ['another machine, no local address', '203.0.113.9', undefined, false],
    ['no peer address', undefined, '127.0.0.1', false],
  ])('%s', (_label, remoteAddress, localAddress, expected) => {
    expect(isLocalPeer({ remoteAddress, localAddress })).toBe(expected);
  });
});
