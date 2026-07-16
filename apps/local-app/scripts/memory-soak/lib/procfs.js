'use strict';

const fs = require('node:fs');
const path = require('node:path');

function parseKeyValueBytes(text) {
  const values = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z_()]+):\s+(\d+)(?:\s+kB)?$/.exec(line.trim());
    if (!match) continue;
    values[match[1]] = Number(match[2]) * 1024;
  }
  return values;
}

function parsePressure(text) {
  const result = {};
  for (const line of text.trim().split('\n')) {
    const [kind, ...fields] = line.trim().split(/\s+/);
    if (!kind) continue;
    result[kind] = {};
    for (const field of fields) {
      const [key, rawValue] = field.split('=');
      result[kind][key] = Number(rawValue);
    }
  }
  return result;
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function readHostMemory() {
  const meminfo = parseKeyValueBytes(readText('/proc/meminfo') || '');
  const pressureText = readText('/proc/pressure/memory');
  return {
    totalBytes: meminfo.MemTotal || 0,
    availableBytes: meminfo.MemAvailable || 0,
    usedBytes: Math.max(0, (meminfo.MemTotal || 0) - (meminfo.MemAvailable || 0)),
    swapTotalBytes: meminfo.SwapTotal || 0,
    swapUsedBytes: Math.max(0, (meminfo.SwapTotal || 0) - (meminfo.SwapFree || 0)),
    pressureAvailable: pressureText !== null,
    pressure: pressureText ? parsePressure(pressureText) : null,
  };
}

function readProcess(pid) {
  const status = readText(`/proc/${pid}/status`);
  if (!status) return null;
  const bytes = parseKeyValueBytes(status);
  const ppidMatch = /^PPid:\s+(\d+)$/m.exec(status);
  return {
    pid,
    ppid: ppidMatch ? Number(ppidMatch[1]) : 0,
    rssBytes: bytes.VmRSS || 0,
    swapBytes: bytes.VmSwap || 0,
  };
}

function listProcesses() {
  let entries = [];
  try {
    entries = fs.readdirSync('/proc', { withFileTypes: true });
  } catch {
    return [];
  }
  const processes = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const processInfo = readProcess(Number(entry.name));
    if (processInfo) processes.push(processInfo);
  }
  return processes;
}

function summarizeProcessTree(rootPid, processes = listProcesses()) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return { rootPid: null, processCount: 0, rssBytes: 0, swapBytes: 0, processes: [] };
  }
  const byParent = new Map();
  for (const processInfo of processes) {
    const children = byParent.get(processInfo.ppid) || [];
    children.push(processInfo.pid);
    byParent.set(processInfo.ppid, children);
  }
  const included = new Set();
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (included.has(pid)) continue;
    included.add(pid);
    queue.push(...(byParent.get(pid) || []));
  }
  const tree = processes.filter((processInfo) => included.has(processInfo.pid));
  return {
    rootPid,
    processCount: tree.length,
    rssBytes: tree.reduce((sum, processInfo) => sum + processInfo.rssBytes, 0),
    swapBytes: tree.reduce((sum, processInfo) => sum + processInfo.swapBytes, 0),
    processes: tree,
  };
}

function resolveCgroup(pid) {
  const membership = readText(`/proc/${pid}/cgroup`);
  if (!membership) return null;
  const unified = membership
    .split('\n')
    .map((line) => line.split(':'))
    .find((parts) => parts.length === 3 && parts[0] === '0' && parts[1] === '');
  if (!unified) return null;
  const relative = unified[2].replace(/^\/+/, '');
  return path.join('/sys/fs/cgroup', relative);
}

function readNumber(filePath) {
  const text = readText(filePath);
  if (text === null) return null;
  const value = Number(text.trim());
  return Number.isFinite(value) ? value : null;
}

function readCgroupMemory(pid) {
  const cgroupPath = resolveCgroup(pid);
  if (!cgroupPath) return { available: false };
  const currentBytes = readNumber(path.join(cgroupPath, 'memory.current'));
  const swapBytes = readNumber(path.join(cgroupPath, 'memory.swap.current'));
  const pressureText = readText(path.join(cgroupPath, 'memory.pressure'));
  return {
    available: currentBytes !== null,
    path: cgroupPath,
    currentBytes,
    swapBytes,
    pressureAvailable: pressureText !== null,
    pressure: pressureText ? parsePressure(pressureText) : null,
  };
}

function sampleSystem(targetPid, workloadPid) {
  const processes = listProcesses();
  const cgroupRootPid = targetPid || workloadPid;
  return {
    capturedAt: new Date().toISOString(),
    monotonicMs: Number(process.hrtime.bigint() / 1_000_000n),
    host: readHostMemory(),
    target: summarizeProcessTree(targetPid, processes),
    workload: summarizeProcessTree(workloadPid, processes),
    cgroup: cgroupRootPid
      ? { rootPid: cgroupRootPid, ...readCgroupMemory(cgroupRootPid) }
      : { rootPid: null, available: false },
    sampler: { pid: process.pid, platform: process.platform },
  };
}

module.exports = {
  parseKeyValueBytes,
  parsePressure,
  readCgroupMemory,
  readHostMemory,
  readProcess,
  sampleSystem,
  summarizeProcessTree,
};
