import { chromium } from '@playwright/test';

const WINDOW_COUNTS = [0, 5, 10, 20];
const HEAVY_CONTENT_ITEMS = 100_000;

async function collectHeap(page) {
  await page.evaluate(() => globalThis.gc?.());
  const session = await page.context().newCDPSession(page);
  await session.send('HeapProfiler.collectGarbage');
  await session.send('Performance.enable');
  const { metrics } = await session.send('Performance.getMetrics');
  await session.detach();
  return metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value ?? 0;
}

async function installHarness(page, renderMinimized) {
  await page.goto('http://127.0.0.1:5175/@vite/client');
  await page.evaluate(
    async ({ renderMinimized, heavyContentItems }) => {
      const reactModule = await import('/@id/react');
      const React = reactModule.default ?? reactModule;
      const reactDomClientModule = await import('/@id/react-dom/client');
      const createRoot = reactDomClientModule.createRoot ?? reactDomClientModule.default.createRoot;
      const { TerminalWindowsProvider, useTerminalWindows } = await import(
        '/src/ui/terminal-windows/TerminalWindowsContext.tsx'
      );

      function HeavyContent({ id }) {
        const retainedPayload = React.useMemo(
          () => Array.from({ length: heavyContentItems }, (_, index) => `${id}:${index}`),
          [id],
        );
        return React.createElement('span', null, retainedPayload[retainedPayload.length - 1]);
      }

      function Harness() {
        const terminalWindows = useTerminalWindows();
        globalThis.__terminalWindowHeapHarness = {
          open(index) {
            terminalWindows.openWindow({
              id: `heap-window-${index}`,
              title: `Heap window ${index}`,
              content: React.createElement(HeavyContent, { id: index }),
            });
          },
          mountedCount: terminalWindows.windows.filter((window) => !window.minimized).length,
        };
        return React.createElement(
          React.Fragment,
          null,
          terminalWindows.windows
            .filter((window) => renderMinimized || !window.minimized)
            .map((window) => React.createElement('div', { key: window.id }, window.content)),
        );
      }

      document.body.replaceChildren(document.createElement('main'));
      createRoot(document.querySelector('main')).render(
        React.createElement(TerminalWindowsProvider, null, React.createElement(Harness)),
      );
    },
    { renderMinimized, heavyContentItems: HEAVY_CONTENT_ITEMS },
  );
  await page.waitForFunction(() => globalThis.__terminalWindowHeapHarness !== undefined);
}

async function sampleScenario(browser, renderMinimized) {
  const page = await browser.newPage();
  await installHarness(page, renderMinimized);
  const samples = [];

  for (const count of WINDOW_COUNTS) {
    const alreadyOpened = samples.length === 0 ? 0 : WINDOW_COUNTS[samples.length - 1];
    for (let index = alreadyOpened; index < count; index += 1) {
      await page.evaluate((windowIndex) => {
        globalThis.__terminalWindowHeapHarness.open(windowIndex);
      }, index);
    }
    await page.waitForFunction(
      (expected) => document.querySelectorAll('main > div').length === expected,
      renderMinimized ? count : Math.min(count, 5),
    );
    samples.push({
      opened: count,
      mounted: await page.evaluate(() => globalThis.__terminalWindowHeapHarness.mountedCount),
      renderedHeavyComponents: await page.locator('main > div').count(),
      heapBytes: await collectHeap(page),
    });
  }

  await page.close();
  return samples;
}

const browser = await chromium.launch({ args: ['--js-flags=--expose-gc'] });
try {
  const capped = await sampleScenario(browser, false);
  const uncappedRenderProxy = await sampleScenario(browser, true);

  if (
    capped.some(
      ({ opened, mounted, renderedHeavyComponents }) =>
        mounted > 5 || renderedHeavyComponents !== Math.min(opened, 5),
    )
  ) {
    throw new Error('Mounted terminal content exceeded the five-window cap');
  }

  const cappedGrowthAfterLimit = capped.at(-1).heapBytes - capped[1].heapBytes;
  const uncappedGrowthAfterLimit =
    uncappedRenderProxy.at(-1).heapBytes - uncappedRenderProxy[1].heapBytes;
  if (cappedGrowthAfterLimit >= uncappedGrowthAfterLimit / 2) {
    throw new Error('Capped heap growth did not plateau relative to the uncapped render proxy');
  }

  process.stdout.write(`${JSON.stringify({ capped, uncappedRenderProxy }, null, 2)}\n`);
} finally {
  await browser.close();
}
