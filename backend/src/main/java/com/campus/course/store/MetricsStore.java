package com.campus.course.store;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

import org.springframework.stereotype.Component;

/**
 * 运行指标采集（对应设计文档 7.5 可观测性与运维，等价于原 Node 版的 store/metrics.js）。
 *
 * <p>纯内存统计，进程重启后清零；供系统管理员的「运行监控」页读取。
 */
@Component
public class MetricsStore {

    private static final int MAX_DURATION_SAMPLES = 2000;

    /** 静态兜底引用：让不依赖注入的响应工具类也能写入指标 */
    private static volatile MetricsStore instance;

    private static final class PathStat {
        final AtomicLong total = new AtomicLong();
        final AtomicLong fail = new AtomicLong();
        final AtomicLong totalMs = new AtomicLong();
    }

    private final long startAt = System.currentTimeMillis();
    private final AtomicLong total = new AtomicLong();
    private final AtomicLong success = new AtomicLong();
    private final AtomicLong fail = new AtomicLong();
    private final Map<String, PathStat> byPath = new ConcurrentHashMap<>();
    private final Map<Integer, AtomicLong> errorsByCode = new ConcurrentHashMap<>();
    private final Deque<Integer> writeDurations = new ArrayDeque<>();

    public MetricsStore() {
        instance = this;
    }

    public static MetricsStore get() {
        return instance;
    }

    /** 记一次请求：method + path + 业务错误码 + 耗时（毫秒）。 */
    public void record(String method, String path, int code, long ms) {
        total.incrementAndGet();
        if (code == 0) {
            success.incrementAndGet();
        } else {
            fail.incrementAndGet();
            errorsByCode.computeIfAbsent(code, k -> new AtomicLong()).incrementAndGet();
        }

        PathStat stat = byPath.computeIfAbsent(method + " " + path, k -> new PathStat());
        stat.total.incrementAndGet();
        if (code != 0) {
            stat.fail.incrementAndGet();
        }
        stat.totalMs.addAndGet(ms);

        if ("POST".equals(method) || "PUT".equals(method) || "DELETE".equals(method)) {
            synchronized (writeDurations) {
                writeDurations.addLast((int) ms);
                while (writeDurations.size() > MAX_DURATION_SAMPLES) {
                    writeDurations.removeFirst();
                }
            }
        }
    }

    private static int percentile(List<Integer> values, int p) {
        if (values.isEmpty()) {
            return 0;
        }
        List<Integer> sorted = new ArrayList<>(values);
        sorted.sort(Comparator.naturalOrder());
        int idx = Math.min(sorted.size() - 1, (int) Math.floor(p / 100.0 * sorted.size()));
        return sorted.get(idx);
    }

    /** 生成监控页所需快照。queueLength 为未引入网关排队时的占位值（恒为 0）。 */
    public Map<String, Object> snapshot(long queueLength) {
        List<Integer> durations;
        synchronized (writeDurations) {
            durations = new ArrayList<>(writeDurations);
        }
        long tot = total.get();
        long ok = success.get();
        long bad = fail.get();

        double avg = durations.isEmpty()
                ? 0
                : durations.stream().mapToInt(Integer::intValue).average().orElse(0);
        double rate = tot == 0 ? 1 : (double) ok / tot;

        List<Map<String, Object>> topPaths = new ArrayList<>();
        byPath.entrySet().stream()
                .sorted((a, b) -> Long.compare(b.getValue().total.get(), a.getValue().total.get()))
                .limit(12)
                .forEach(e -> {
                    PathStat s = e.getValue();
                    long t = s.total.get();
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("path", e.getKey());
                    m.put("total", t);
                    m.put("fail", s.fail.get());
                    m.put("avgMs", t == 0 ? 0 : Math.round((double) s.totalMs.get() / t));
                    m.put("errorRate", t == 0 ? 0 : Math.round((double) s.fail.get() / t * 10000) / 100.0);
                    topPaths.add(m);
                });

        List<Map<String, Object>> errors = new ArrayList<>();
        errorsByCode.entrySet().stream()
                .sorted((a, b) -> Long.compare(b.getValue().get(), a.getValue().get()))
                .forEach(e -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("code", e.getKey());
                    m.put("count", e.getValue().get());
                    errors.add(m);
                });

        Map<String, Object> snap = new LinkedHashMap<>();
        snap.put("uptimeSeconds", Math.round((System.currentTimeMillis() - startAt) / 1000.0));
        snap.put("totalRequests", tot);
        snap.put("successRequests", ok);
        snap.put("failedRequests", bad);
        snap.put("successRate", Math.round(rate * 10000) / 100.0);
        snap.put("writeP95Ms", percentile(durations, 95));
        snap.put("writeAvgMs", Math.round(avg));
        snap.put("queueLength", queueLength);
        // 未引入 Redis 缓存，缓存与数据库余量差值恒为 0（设计文档 8.3 的可选增强项）
        snap.put("cacheDiff", 0);
        snap.put("errorsByCode", errors);
        snap.put("topPaths", topPaths);
        return snap;
    }
}
