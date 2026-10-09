import type { IncomingHttpHeaders } from 'node:http';
import { BROWSER_ORIGIN_REJECTION, guardBrowserRequest } from './browser-request-guard';

const navigation = {
  'sec-fetch-site': 'cross-site',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
};
type Case = {
  name: string;
  headers?: IncomingHttpHeaders;
  path?: string;
  method?: string;
  allowedHostnames?: string[];
  refused?: boolean;
};

// The pure guard is the cheapest layer for the header and callback decision matrix.
describe('guardBrowserRequest', () => {
  it.each([
    { name: 'CLI without Origin or Fetch Metadata' },
    { name: 'loopback IPv4 origin on another port', headers: { origin: 'http://127.0.0.1:5175' } },
    { name: 'localhost origin', headers: { origin: 'http://localhost:5175' } },
    { name: 'loopback IPv6 origin', headers: { origin: 'http://[::1]:5175' } },
    {
      name: 'same origin on a permitted DNS host',
      headers: { host: 'myhost.lan:3000', origin: 'http://myhost.lan:3000' },
      allowedHostnames: ['myhost.lan'],
    },
    {
      name: 'same origin with a default HTTPS port',
      headers: { host: 'myhost.lan:443', origin: 'https://myhost.lan' },
      allowedHostnames: ['myhost.lan'],
    },
    {
      name: 'foreign port on a permitted DNS host',
      headers: { host: 'myhost.lan:3000', origin: 'http://myhost.lan:4000' },
      allowedHostnames: ['myhost.lan'],
      refused: true,
    },
    { name: 'foreign origin', headers: { origin: 'https://evil.example' }, refused: true },
    { name: 'opaque origin', headers: { origin: 'null' }, refused: true },
    { name: 'empty origin', headers: { origin: '' }, refused: true },
    { name: 'malformed origin', headers: { origin: 'not-a-url' }, refused: true },
    {
      name: 'multiple origins',
      headers: { origin: 'http://localhost, https://evil.example' },
      refused: true,
    },
    {
      name: 'origin containing credentials',
      headers: { origin: 'http://secret@localhost' },
      refused: true,
    },
    {
      name: 'origin containing a path',
      headers: { origin: 'http://localhost/path' },
      refused: true,
    },
    { name: 'non-HTTP origin', headers: { origin: 'file://localhost/' }, refused: true },
    { name: 'cross-site API GET', headers: { 'sec-fetch-site': 'cross-site' }, refused: true },
    { name: 'cross-site API POST navigation', method: 'POST', headers: navigation, refused: true },
    { name: 'callback GET navigation', headers: navigation, path: '/auth/cloud/callback' },
    {
      name: 'callback HEAD navigation with query',
      method: 'HEAD',
      headers: navigation,
      path: '/auth/cloud/callback?state=abc',
    },
    {
      name: 'callback POST navigation',
      method: 'POST',
      headers: navigation,
      path: '/auth/cloud/callback',
      refused: true,
    },
    { name: 'other UI GET navigation', headers: navigation, path: '/projects', refused: true },
    {
      name: 'callback suffix navigation',
      headers: navigation,
      path: '/auth/cloud/callback/extra',
      refused: true,
    },
    {
      name: 'callback fetch',
      headers: { ...navigation, 'sec-fetch-mode': 'cors' },
      path: '/auth/cloud/callback',
      refused: true,
    },
    {
      name: 'callback iframe',
      headers: { ...navigation, 'sec-fetch-dest': 'iframe' },
      path: '/auth/cloud/callback',
      refused: true,
    },
    {
      name: 'callback foreign origin',
      headers: { ...navigation, origin: 'https://evil.example' },
      path: '/auth/cloud/callback',
      refused: true,
    },
    {
      name: 'callback foreign host',
      headers: { ...navigation, host: 'evil.example' },
      path: '/auth/cloud/callback',
      refused: true,
    },
    {
      name: 'DNS rebinding host',
      headers: { host: 'evil.example:3000', origin: 'http://evil.example:3000' },
      refused: true,
    },
    { name: 'DNS host without Origin', headers: { host: 'evil.example' }, refused: true },
    { name: 'IPv4 literal host', headers: { host: '192.0.2.10:3000' } },
    { name: 'bracketed loopback IPv6 host', headers: { host: '[::1]:3000' } },
    { name: 'bracketed non-loopback IPv6 host', headers: { host: '[2001:db8::10]:3000' } },
    {
      name: 'configured hostname',
      headers: { host: 'myhost.lan:3000' },
      allowedHostnames: ['myhost.lan'],
    },
    {
      name: 'explicit allowed hostname',
      headers: { host: 'alias.lan:3000' },
      allowedHostnames: ['myhost.lan', 'alias.lan'],
    },
    {
      name: 'hostname case normalization',
      headers: { host: 'MYHOST.LAN:3000' },
      allowedHostnames: ['MyHost.Lan'],
    },
    { name: 'loopback DNS host', headers: { host: 'localhost:3000' } },
    { name: 'missing host', headers: { host: undefined }, refused: true },
    { name: 'empty host', headers: { host: '' }, refused: true },
    { name: 'malformed IPv6 host', headers: { host: '[::1' }, refused: true },
    {
      name: 'host containing credentials',
      headers: { host: 'evil.example@localhost:3000' },
      refused: true,
    },
    { name: 'host containing a path', headers: { host: 'localhost:3000/path' }, refused: true },
    { name: 'host containing a query', headers: { host: 'localhost:3000?other' }, refused: true },
  ] as Case[])('$name', ({ headers, path, method, allowedHostnames, refused }) => {
    expect(
      guardBrowserRequest(
        { host: '127.0.0.1:3000', ...headers },
        path ?? '/api/sessions',
        method ?? 'GET',
        allowedHostnames ?? [],
      ),
    ).toEqual(refused ? BROWSER_ORIGIN_REJECTION : null);
  });
});
