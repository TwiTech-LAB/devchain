import { stripAlternateScreenSequences } from './ansi-sanitizer';

// Test layer: pure-function unit. This is the cheapest layer that proves the
// strip regex/semantics — no DI, no mocks, no terminal state. The OpenCode
// SKIP-STRIP (which keeps the combined DECSET so mouse-tracking survives) is
// covered at the PTY layer in pty.service.spec.ts; these tests lock the strip
// behavior that the default (non-TUI) providers still rely on, and document
// WHY the per-provider skip-strip exists: a combined `?1049;1000h` loses the
// mouse-tracking enable when the whole DECSET is removed.

describe('stripAlternateScreenSequences', () => {
  it('strips the primary alt-screen enter sequence (?1049h)', () => {
    expect(stripAlternateScreenSequences('\x1b[?1049h')).toBe('');
  });

  it('strips the alt-screen leave sequence (?1049l)', () => {
    expect(stripAlternateScreenSequences('\x1b[?1049l')).toBe('');
  });

  it('strips the legacy alt-screen enter sequences (?1047h / ?47h)', () => {
    expect(stripAlternateScreenSequences('\x1b[?1047h')).toBe('');
    expect(stripAlternateScreenSequences('\x1b[?47h')).toBe('');
  });

  // This is the core collateral-damage case that motivates the per-provider
  // skip-strip: a full-screen TUI emits alt-screen + mouse-tracking enable in a
  // SINGLE combined DECSET. The sanitizer strips the WHOLE sequence (it contains
  // 1049), so for default providers the mouse-tracking enable is lost too. For
  // OpenCode the PTY layer skips the strip entirely (preserves both); see
  // pty.service.spec.ts → "skips the strip for TUI providers".
  it('strips the WHOLE combined DECSET when it contains an alt-screen code (documented collateral)', () => {
    expect(stripAlternateScreenSequences('\x1b[?1049;1000h')).toBe('');
    expect(stripAlternateScreenSequences('\x1b[?1000;1049h')).toBe('');
    expect(stripAlternateScreenSequences('\x1b[?47;1000;1049h')).toBe('');
  });

  it('PRESERVES mouse-tracking-only DECSETs (no alt-screen code → no collateral strip)', () => {
    // ?1000 / ?1002 / ?1003 are mouse-tracking enables with NO alt-screen code;
    // because the sanitizer only strips when 47/1047/1049 is present, these survive.
    expect(stripAlternateScreenSequences('\x1b[?1000h')).toBe('\x1b[?1000h');
    expect(stripAlternateScreenSequences('\x1b[?1002h')).toBe('\x1b[?1002h');
    expect(stripAlternateScreenSequences('\x1b[?1003h')).toBe('\x1b[?1003h');
    expect(stripAlternateScreenSequences('\x1b[?1000l')).toBe('\x1b[?1000l');
  });

  it('PRESERVES other unrelated DEC Private Mode sequences (cursor show, bracketed paste, etc.)', () => {
    expect(stripAlternateScreenSequences('\x1b[?25h')).toBe('\x1b[?25h'); // cursor show
    expect(stripAlternateScreenSequences('\x1b[?25l')).toBe('\x1b[?25l'); // cursor hide
    expect(stripAlternateScreenSequences('\x1b[?2004h')).toBe('\x1b[?2004h'); // bracketed paste
  });

  it('strips multiple alt-screen toggles within a single chunk', () => {
    const chunk = 'before\x1b[?1049hmid\x1b[?1049lafter';
    expect(stripAlternateScreenSequences(chunk)).toBe('beforemidafter');
  });

  it('leaves regular text and non-DEC-private CSI sequences untouched', () => {
    expect(stripAlternateScreenSequences('hello world')).toBe('hello world');
    expect(stripAlternateScreenSequences('\x1b[0m\x1b[1;31mred\x1b[0m')).toBe(
      '\x1b[0m\x1b[1;31mred\x1b[0m',
    );
    expect(stripAlternateScreenSequences('\x1b[2J\x1b[H')).toBe('\x1b[2J\x1b[H'); // clear + home
  });

  it('leaves an empty string empty', () => {
    expect(stripAlternateScreenSequences('')).toBe('');
  });
});
