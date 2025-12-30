import { CONTROL_KEY_MAP, isControlKey, toTmuxKeys } from './control-keys';

describe('terminal control keys mapping', () => {
  it('contains expected basic mappings', () => {
    expect(CONTROL_KEY_MAP['\x1b']).toEqual(['Escape']);
    expect(CONTROL_KEY_MAP['\r']).toEqual(['Enter']);
    expect(CONTROL_KEY_MAP['\n']).toEqual(['Enter']);
    expect(CONTROL_KEY_MAP['\x03']).toEqual(['C-c']);
    expect(CONTROL_KEY_MAP['\x04']).toEqual(['C-d']);
    expect(CONTROL_KEY_MAP['\x0c']).toEqual(['C-l']);
    expect(CONTROL_KEY_MAP['\x1a']).toEqual(['C-z']);
    expect(CONTROL_KEY_MAP['\t']).toEqual(['Tab']);
    expect(CONTROL_KEY_MAP['\x7f']).toEqual(['BSpace']);
  });

  it('contains expected arrow key mappings', () => {
    expect(CONTROL_KEY_MAP['\x1b[A']).toEqual(['Up']);
    expect(CONTROL_KEY_MAP['\x1b[B']).toEqual(['Down']);
    expect(CONTROL_KEY_MAP['\x1b[C']).toEqual(['Right']);
    expect(CONTROL_KEY_MAP['\x1b[D']).toEqual(['Left']);
  });

  it('isControlKey returns true for mapped keys and false otherwise', () => {
    for (const k of Object.keys(CONTROL_KEY_MAP)) {
      expect(isControlKey(k)).toBe(true);
    }
    expect(isControlKey('a')).toBe(false);
    expect(isControlKey('XYZ')).toBe(false);
  });

  it('toTmuxKeys returns mapped keys or literal fallback', () => {
    expect(toTmuxKeys('\x03')).toEqual(['C-c']);
    expect(toTmuxKeys('a')).toEqual(['a']);
  });
});
