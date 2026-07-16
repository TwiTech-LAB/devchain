import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const versions = [
  {
    label: 'xterm-5.5.0',
    modulePath: path.join(
      repoRoot,
      'node_modules/devchain-cli/node_modules/@xterm/xterm/lib/xterm.js',
    ),
  },
  {
    label: 'xterm-6.0.0',
    modulePath: path.join(repoRoot, 'node_modules/@xterm/xterm/lib/xterm.mjs'),
  },
];

function processRssBytes(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    return match ? Number(match[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

async function sample(page, browserSession) {
  await page.evaluate(() => globalThis.gc?.());
  const pageSession = await page.context().newCDPSession(page);
  await pageSession.send('HeapProfiler.collectGarbage');
  await pageSession.send('Performance.enable');
  const [{ metrics }, dom] = await Promise.all([
    pageSession.send('Performance.getMetrics'),
    pageSession.send('Memory.getDOMCounters'),
  ]);
  await pageSession.detach();
  const { processInfo } = await browserSession.send('SystemInfo.getProcessInfo');
  return {
    jsHeapUsedBytes: metrics.find(({ name }) => name === 'JSHeapUsedSize')?.value ?? 0,
    nativeProcessRssBytes: processInfo.reduce((total, info) => total + processRssBytes(info.id), 0),
    domDocuments: dom.documents,
    domNodes: dom.nodes,
    jsEventListeners: dom.jsEventListeners,
  };
}

async function runVersion(version) {
  if (!fs.existsSync(version.modulePath)) {
    throw new Error(`Missing comparison module: ${version.modulePath}`);
  }

  const browser = await chromium.launch({ args: ['--js-flags=--expose-gc'] });
  try {
    const browserSession = await browser.newBrowserCDPSession();
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.goto('http://127.0.0.1:5175/@vite/client');
    await page.evaluate(async (moduleUrl) => {
      const module = await import(moduleUrl);
      globalThis.__TerminalForRetention =
        module.Terminal ?? module.default?.Terminal ?? globalThis.Terminal;
      if (!globalThis.__TerminalForRetention) throw new Error('Terminal export is unavailable');
      globalThis.__runTerminalRetentionCycle = async (cycle) => {
        const host = document.createElement('div');
        host.style.width = '800px';
        host.style.height = '420px';
        document.body.appendChild(host);
        const terminal = new globalThis.__TerminalForRetention({
          cols: 100,
          rows: 30,
          scrollback: 200,
        });
        terminal.open(host);
        const payload = Array.from(
          { length: 500 },
          (_, index) => `cycle-${cycle}-line-${index}-${'x'.repeat(80)}\r\n`,
        ).join('');
        await new Promise((resolve) => terminal.write(payload, resolve));
        await new Promise((resolve) =>
          terminal.write('\x1b[?1049h\x1b[?1000hTUI\x1b[?1000l\x1b[?1049l', resolve),
        );
        terminal.dispose();
        host.remove();
      };
    }, `/@fs${version.modulePath}`);

    await page.evaluate(() => globalThis.__runTerminalRetentionCycle('warmup'));
    const samples = [{ completedCycles: 0, ...(await sample(page, browserSession)) }];
    for (let cycle = 1; cycle <= 30; cycle += 1) {
      await page.evaluate((index) => globalThis.__runTerminalRetentionCycle(index), cycle);
      if (cycle % 10 === 0) {
        samples.push({ completedCycles: cycle, ...(await sample(page, browserSession)) });
      }
    }
    await browserSession.detach();
    return { label: version.label, samples };
  } finally {
    await browser.close();
  }
}

const runs = [];
for (const version of versions) runs.push(await runVersion(version));

for (const run of runs) {
  const baseline = run.samples[0];
  const final = run.samples.at(-1);
  run.retainedDelta = {
    jsHeapUsedBytes: final.jsHeapUsedBytes - baseline.jsHeapUsedBytes,
    nativeProcessRssBytes: final.nativeProcessRssBytes - baseline.nativeProcessRssBytes,
    domDocuments: final.domDocuments - baseline.domDocuments,
    domNodes: final.domNodes - baseline.domNodes,
    jsEventListeners: final.jsEventListeners - baseline.jsEventListeners,
  };
  run.plateau = {
    jsHeapGrowthLastTenCycles: final.jsHeapUsedBytes - run.samples.at(-2).jsHeapUsedBytes,
    nativeRssGrowthLastTenCycles:
      final.nativeProcessRssBytes - run.samples.at(-2).nativeProcessRssBytes,
  };
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  workload: {
    cycles: 30,
    linesPerCycle: 500,
    columns: 100,
    rows: 30,
    scrollback: 200,
    lifecycle: 'open, primary-buffer write, alternate-screen/mouse toggle, dispose',
  },
  runs,
  delta6Minus5: {
    retainedJsHeapBytes:
      runs[1].retainedDelta.jsHeapUsedBytes - runs[0].retainedDelta.jsHeapUsedBytes,
    retainedNativeRssBytes:
      runs[1].retainedDelta.nativeProcessRssBytes - runs[0].retainedDelta.nativeProcessRssBytes,
  },
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), serialized);
process.stdout.write(serialized);
