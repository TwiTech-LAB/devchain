import { fixturePid, killFixturePid } from './fixture-pid';

// A recording kill function stands in for process.kill: no real process is signalled.
describe('killFixturePid', () => {
  it.each([
    ['an empty file', ''],
    ['a newline only', '\n'],
    ['a zero', '0'],
    ['a negative PID', '-12'],
    ['a partial write', '12 3'],
    ['text', 'pid'],
    ['a fraction', '12.5'],
  ])('sends no signal for %s', (_case, text) => {
    const kill = jest.fn();

    killFixturePid(text, kill);

    expect(kill).not.toHaveBeenCalled();
    expect(fixturePid(text)).toBeNull();
  });

  it('signals a valid PID once', () => {
    const kill = jest.fn();

    killFixturePid('4321\n', kill);

    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(4321, 'SIGKILL');
  });

  it('ignores a process that is already gone', () => {
    const kill = jest.fn(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    });

    expect(() => killFixturePid('4321', kill)).not.toThrow();
  });
});
