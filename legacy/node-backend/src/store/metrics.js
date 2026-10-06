'use strict';

/**
 * 运行指标采集（见设计文档 7.5 可观测性与运维）。
 * 内存统计，进程重启后清零。
 */

const state = {
  startAt: Date.now(),
  total: 0,
  success: 0,
  fail: 0,
  byPath: new Map(), // `${method} ${path}` -> { total, fail, totalMs }
  errorsByCode: new Map(),
  durations: [], // 最近 2000 次写请求耗时
};

const MAX_DURATION_SAMPLES = 2000;
const WRITE_PATHS = ['POST', 'PUT', 'DELETE'];

function record(req, path, code, ms) {
  state.total += 1;
  if (code === 0) state.success += 1;
  else {
    state.fail += 1;
    state.errorsByCode.set(code, (state.errorsByCode.get(code) || 0) + 1);
  }

  const key = `${req.method} ${path}`;
  const item = state.byPath.get(key) || { total: 0, fail: 0, totalMs: 0 };
  item.total += 1;
  if (code !== 0) item.fail += 1;
  item.totalMs += ms;
  state.byPath.set(key, item);

  if (WRITE_PATHS.includes(req.method)) {
    state.durations.push(ms);
    if (state.durations.length > MAX_DURATION_SAMPLES) state.durations.shift();
  }
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function snapshot(queueLength = 0) {
  const durations = state.durations;
  const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  const rate = state.total ? state.success / state.total : 1;

  const topPaths = [...state.byPath.entries()]
    .map(([path, v]) => ({
      path,
      total: v.total,
      fail: v.fail,
      avgMs: v.total ? Math.round(v.totalMs / v.total) : 0,
      errorRate: v.total ? Math.round((v.fail / v.total) * 10000) / 100 : 0,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 12);

  return {
    uptimeSeconds: Math.round((Date.now() - state.startAt) / 1000),
    totalRequests: state.total,
    successRequests: state.success,
    failedRequests: state.fail,
    successRate: Math.round(rate * 10000) / 100,
    writeP95Ms: percentile(durations, 95),
    writeAvgMs: Math.round(avg),
    queueLength,
    cacheDiff: 0, // 未引入 Redis 缓存，缓存与数据库余量差值恒为 0
    errorsByCode: [...state.errorsByCode.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
    topPaths,
  };
}

module.exports = { record, snapshot };
