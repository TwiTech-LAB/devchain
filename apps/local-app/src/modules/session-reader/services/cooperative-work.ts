import { setImmediate } from 'node:timers/promises';

/** Share one budget across nested loops so microtask awaits cannot starve socket IO. */
export function cooperativeBudget(sliceMs = 8): () => Promise<void> | undefined {
  let deadline = performance.now() + sliceMs;
  return () => {
    if (performance.now() < deadline) return undefined;
    return setImmediate().then(() => {
      deadline = performance.now() + sliceMs;
    });
  };
}

/** Runs step-yielding work to completion without pausing. */
export function runSteps<R>(work: Generator<void, R>): R {
  let next = work.next();
  while (!next.done) next = work.next();
  return next.value;
}

/** Runs step-yielding work, pausing between steps whenever the budget is spent. */
export async function runStepsCooperatively<R>(
  work: Generator<void, R>,
  checkpoint = cooperativeBudget(),
): Promise<R> {
  let next = work.next();
  while (!next.done) {
    const pause = checkpoint();
    if (pause) await pause;
    next = work.next();
  }
  return next.value;
}

export async function cooperativeMap<T, R>(
  values: readonly T[],
  project: (value: T) => R,
  checkpoint = cooperativeBudget(),
): Promise<R[]> {
  const result: R[] = [];
  for (const value of values) {
    result.push(project(value));
    const pause = checkpoint();
    if (pause) await pause;
  }
  return result;
}
