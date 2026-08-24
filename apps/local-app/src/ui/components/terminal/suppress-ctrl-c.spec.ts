import { shouldWithholdCtrlC } from './suppress-ctrl-c';

type Ev = Parameters<typeof shouldWithholdCtrlC>[0];
const key = (over: Partial<Ev> = {}): Ev => ({
  type: 'keydown',
  key: 'c',
  ctrlKey: true,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...over,
});

describe('shouldWithholdCtrlC', () => {
  it('withholds a bare Ctrl+C while text is selected', () => {
    expect(shouldWithholdCtrlC(key(), true, true)).toBe(true);
    expect(shouldWithholdCtrlC(key({ key: 'C' }), true, true)).toBe(true);
  });

  // Without a selection Ctrl+C is the only way to interrupt a running agent.
  it('forwards Ctrl+C when nothing is selected', () => {
    expect(shouldWithholdCtrlC(key(), false, true)).toBe(false);
  });

  it('forwards Ctrl+C when the setting is off', () => {
    expect(shouldWithholdCtrlC(key(), true, false)).toBe(false);
  });

  it('ignores keyup, so the release is never swallowed on its own', () => {
    expect(shouldWithholdCtrlC(key({ type: 'keyup' }), true, true)).toBe(false);
  });

  it('leaves other shortcuts alone', () => {
    expect(shouldWithholdCtrlC(key({ shiftKey: true }), true, true)).toBe(false);
    expect(shouldWithholdCtrlC(key({ altKey: true }), true, true)).toBe(false);
    expect(shouldWithholdCtrlC(key({ metaKey: true }), true, true)).toBe(false);
    expect(shouldWithholdCtrlC(key({ key: 'v' }), true, true)).toBe(false);
    expect(shouldWithholdCtrlC(key({ ctrlKey: false }), true, true)).toBe(false);
  });
});
