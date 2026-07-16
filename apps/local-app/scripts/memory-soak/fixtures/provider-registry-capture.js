'use strict';

const fs = require('node:fs');
const Module = require('node:module');

const FACTORY_PATCHED = Symbol.for('devchain.memorySoak.providerFactoryPatched');
const SUMMARY_PATCHED = Symbol.for('devchain.memorySoak.providerSummaryPatched');

function readCapture(capturePath) {
  try {
    return JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  } catch {
    return { providers: [], summaryContracts: {} };
  }
}

function writeCapture(capturePath, update) {
  const current = readCapture(capturePath);
  update(current);
  const temporaryPath = `${capturePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, capturePath);
}

function captureSummaryContract(capturePath, providerName, result, error) {
  writeCapture(capturePath, (capture) => {
    capture.summaryContracts[providerName] = {
      available: Boolean(result),
      exactFields: Array.isArray(result?.exactFields) ? [...result.exactFields] : [],
      approximateFields: Array.isArray(result?.approximateFields)
        ? [...result.approximateFields]
        : [],
      warnings: Array.isArray(result?.warnings) ? [...result.warnings] : [],
      ...(error ? { error: String(error?.message ?? error) } : {}),
    };
  });
}

function instrumentSummary(adapter, capturePath) {
  if (typeof adapter?.getSummary !== 'function' || adapter[SUMMARY_PATCHED]) return;
  const originalGetSummary = adapter.getSummary;
  Object.defineProperty(adapter, SUMMARY_PATCHED, { value: true });
  adapter.getSummary = async function instrumentedGetSummary(...args) {
    try {
      const result = await originalGetSummary.apply(this, args);
      captureSummaryContract(capturePath, adapter.providerName, result, null);
      return result;
    } catch (error) {
      captureSummaryContract(capturePath, adapter.providerName, null, error);
      throw error;
    }
  };
}

function instrumentFactory(FactoryClass, capturePath) {
  if (!capturePath || typeof FactoryClass !== 'function') return;
  const prototype = FactoryClass.prototype;
  if (!prototype || prototype[FACTORY_PATCHED]) return;
  const originalRegisterAdapter = prototype.registerAdapter;
  if (typeof originalRegisterAdapter !== 'function') return;
  Object.defineProperty(prototype, FACTORY_PATCHED, { value: true });
  prototype.registerAdapter = function instrumentedRegisterAdapter(adapter) {
    instrumentSummary(adapter, capturePath);
    const result = originalRegisterAdapter.call(this, adapter);
    writeCapture(capturePath, (capture) => {
      capture.providers = [...this.getSupportedProviders()];
    });
    return result;
  };
}

function installLoaderHook(capturePath) {
  const originalLoad = Module._load;
  Module._load = function providerRegistryCaptureLoad(request, parent, isMain) {
    const loaded = originalLoad.call(this, request, parent, isMain);
    if (loaded?.SessionReaderAdapterFactory) {
      instrumentFactory(loaded.SessionReaderAdapterFactory, capturePath);
    }
    return loaded;
  };
}

const capturePath = process.env.MEMORY_SOAK_PROVIDER_REGISTRY_FILE;
if (capturePath) installLoaderHook(capturePath);

module.exports = {
  instrumentFactory,
};
