package com.campus.course.store;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import org.springframework.stereotype.Component;

import com.campus.course.config.AppProperties;

/**
 * 写操作幂等缓存（对应设计文档 2.4，等价于原 Node 版的 store/idempotency.js）。
 *
 * <p>选课、退课、换课、候补等接口要求前端携带 requestId；服务端缓存首次执行结果，
 * 重复提交（例如网络抖动导致的重发、用户连点）直接返回首次结果，不会重复扣减名额。
 * 成功与业务错误都缓存，保证重复提交拿到一致的返回体。
 */
@Component
public class IdempotencyStore {

    private record Item(long at, Object result) {
    }

    private final Map<String, Item> store = new ConcurrentHashMap<>();
    private final long ttlMillis;

    public IdempotencyStore(AppProperties props) {
        this.ttlMillis = props.getIdempotencyTtlMinutes() * 60L * 1000L;
    }

    /** 命中缓存返回首次结果，否则返回 null。 */
    public Object hit(long userId, String requestId) {
        if (requestId == null || requestId.isEmpty()) {
            return null;
        }
        String key = userId + ":" + requestId;
        Item item = store.get(key);
        if (item == null) {
            return null;
        }
        if (System.currentTimeMillis() - item.at() > ttlMillis) {
            store.remove(key);
            return null;
        }
        return item.result();
    }

    /** 记录首次执行结果。 */
    public void save(long userId, String requestId, Object result) {
        if (requestId == null || requestId.isEmpty()) {
            return;
        }
        store.put(userId + ":" + requestId, new Item(System.currentTimeMillis(), result));
    }

    /** 定期清理过期条目，避免请求量上来后内存持续增长。 */
    public void sweep() {
        long now = System.currentTimeMillis();
        store.entrySet().removeIf(e -> now - e.getValue().at() > ttlMillis);
    }
}
