import { transcriptJsonStream } from './transcript-json-stream';

async function collect(value: unknown): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of transcriptJsonStream(value)) parts.push(part);
  return Buffer.concat(parts).toString('utf8');
}

// Pure encoder tests own byte parity and yielding without involving storage or sockets.
describe('transcriptJsonStream', () => {
  it('matches JSON.stringify for transcript values, omissions, Dates, and Unicode boundaries', async () => {
    const value = {
      cursor: 'cursor',
      timestamp: new Date('2026-01-01T00:00:00Z'),
      missing: undefined,
      empty: [],
      null: null,
      number: 1.25,
      flag: true,
      special: [undefined, NaN, Infinity, -Infinity, -0, '\r\n\t"\\\u0000', '\ud800', '\udfff'],
      content: 'a'.repeat(16 * 1024 - 1) + '😀' + '日本語'.repeat(30000),
      repeated: [{ text: 'hello' }, { text: 'hello' }],
    };
    expect(await collect(value)).toBe(JSON.stringify(value));
  });

  it('yields while encoding a large answer and bounds each buffered output fragment', async () => {
    const value = { text: '😀\n"'.repeat(2_000_000) };
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    let size = 0;
    try {
      for await (const part of transcriptJsonStream(value)) {
        expect(part.length).toBeLessThan(512 * 1024);
        size += part.length;
      }
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
    expect(size).toBe(Buffer.byteLength(JSON.stringify(value)));
  });

  it('rejects circular content but allows the same object in separate branches', async () => {
    const child = { text: 'shared' };
    expect(await collect({ a: child, b: child })).toBe(JSON.stringify({ a: child, b: child }));
    const circular: { self?: unknown } = {};
    circular.self = circular;
    await expect(collect(circular)).rejects.toThrow('circular');
  });

  it('stops encoding when the consumer closes the stream', async () => {
    let inspected = false;
    const stream = transcriptJsonStream({
      text: 'x'.repeat(1024 * 1024),
      get next() {
        inspected = true;
        return 'unused';
      },
    });
    for await (const part of stream) {
      expect(part.length).toBeGreaterThan(0);
      break;
    }
    expect(stream.destroyed).toBe(true);
    expect(inspected).toBe(false);
  });
});
