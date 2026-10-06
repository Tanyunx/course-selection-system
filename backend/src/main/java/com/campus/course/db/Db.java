package com.campus.course.db;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 数据访问层统一入口。
 *
 * <p>本类等价于原 Node 版 {@code src/db.js}，提供 query / queryOne / update /
 * insertReturningId / withTransaction 五个方法，全部使用 {@code ?} 占位符，
 * 因此原先写在 SQL 里的语句可以逐条对照移植，便于评审与比对。
 *
 * <p>与 MySQL 的两点差异在本类中统一吸收，业务代码无需感知：
 * <ol>
 *   <li>MySQL 的 {@code IN (?)} 由驱动自动把数组展开成列表；PostgreSQL 的 JDBC
 *       驱动不支持，这里在 {@link #prepare} 里按参数类型自动展开成 {@code IN (?,?,…)}。</li>
 *   <li>MySQL 用 {@code insertId} 返回自增主键；PostgreSQL 用 {@code INSERT … RETURNING id}，
 *       由 {@link #insertReturningId} 封装。</li>
 * </ol>
 *
 * <p>事务：{@link #withTransaction} 基于 Spring 的 TransactionTemplate，
 * 同一个线程内的 JdbcTemplate 会自动加入当前事务，因此业务代码不再需要像
 * Node 版那样显式传递 {@code conn}，也就不会出现"事务里再去连接池取连接"导致的
 * 连接池耗尽死锁（原 Node 版用 {@code runner(conn)} 规避的正是这个问题）。
 */
@Repository
public class Db {

    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;

    public Db(JdbcTemplate jdbc, PlatformTransactionManager transactionManager) {
        this.jdbc = jdbc;
        this.tx = new TransactionTemplate(transactionManager);
    }

    /* ------------------------------------------------------------------ */
    /* 查询                                                                */
    /* ------------------------------------------------------------------ */

    /** 查询多行；列名（含别名）原样作为 Map 的 key，保持与 SQL 中的 snake_case 一致。 */
    public List<Map<String, Object>> query(String sql, Object... args) {
        Prepared p = prepare(sql, args);
        return jdbc.queryForList(p.sql(), p.args());
    }

    /** 查询单行，无结果返回 null。 */
    public Map<String, Object> queryOne(String sql, Object... args) {
        List<Map<String, Object>> rows = query(sql, args);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /** 查询单列标量，无结果返回 null。 */
    public <T> T queryScalar(String sql, Class<T> type, Object... args) {
        Prepared p = prepare(sql, args);
        List<T> list = jdbc.queryForList(p.sql(), type, p.args());
        return list.isEmpty() ? null : list.get(0);
    }

    /* ------------------------------------------------------------------ */
    /* 写入                                                                */
    /* ------------------------------------------------------------------ */

    /** 执行 INSERT / UPDATE / DELETE，返回受影响行数（并发控制的判断依据）。 */
    public int update(String sql, Object... args) {
        Prepared p = prepare(sql, args);
        return jdbc.update(p.sql(), p.args());
    }

    /**
     * 插入并返回自增主键，等价于 MySQL 的 {@code result.insertId}。
     * 调用方只需写标准的 INSERT 语句，本方法会补上 {@code RETURNING id}。
     */
    public long insertReturningId(String sql, Object... args) {
        Prepared p = prepare(sql, args);
        String s = p.sql().strip();
        while (s.endsWith(";")) {
            s = s.substring(0, s.length() - 1).strip();
        }
        if (!s.toUpperCase().contains("RETURNING")) {
            s = s + " RETURNING id";
        }
        Long id = queryScalar(s, Long.class, p.args());
        return id == null ? 0L : id;
    }

    /* ------------------------------------------------------------------ */
    /* 事务                                                                */
    /* ------------------------------------------------------------------ */

    /**
     * 在事务中执行，回调返回什么就返回什么；抛异常则整体回滚。
     * 用于选课的"占名额 + 校验 + 落库"、换课的"先占后放"等需要原子性的场景。
     */
    public <T> T withTransaction(Supplier<T> handler) {
        return tx.execute(status -> handler.get());
    }

    /** 无返回值的写法，便于在事务里直接调用 void 型业务方法。 */
    public void inTransaction(Runnable handler) {
        tx.executeWithoutResult(status -> handler.run());
    }

    /* ------------------------------------------------------------------ */
    /* 健康检查                                                            */
    /* ------------------------------------------------------------------ */

    /** 探测数据库连通性（供 /api/health 使用）。 */
    public void ping() {
        jdbc.queryForObject("SELECT 1", Integer.class);
    }

    /* ------------------------------------------------------------------ */
    /* 内部：占位符预处理                                                  */
    /* ------------------------------------------------------------------ */

    private record Prepared(String sql, Object[] args) {
    }

    /**
     * 把 {@code IN (?)} + 集合参数展开成 {@code IN (?,?,…)}。
     * 集合为空时展开为 {@code IN (NULL)}——语义上是"永不匹配"，避免出现非法 SQL。
     */
    static Prepared prepare(String sql, Object[] args) {
        if (args == null || args.length == 0) {
            return new Prepared(sql, new Object[0]);
        }
        StringBuilder out = new StringBuilder(sql.length() + 32);
        List<Object> flat = new ArrayList<>(args.length + 8);
        int argIdx = 0;
        for (int i = 0; i < sql.length(); i++) {
            char c = sql.charAt(i);
            if (c != '?') {
                out.append(c);
                continue;
            }
            if (argIdx >= args.length) {
                // 占位符比参数多时必须立刻报错。历史教训：SQL 的注释里误写了一个问号，
                // 旧实现会「默默补一个 null」继续执行，最终由 PostgreSQL 抛出
                // "栏位索引超过许可范围"，排查成本极高。
                throw new IllegalArgumentException(
                        "SQL 占位符数量多于参数数量：第 " + (argIdx + 1) + " 个占位符没有对应参数，SQL=" + sql);
            }
            Object arg = args[argIdx++];
            Collection<?> coll = asCollection(arg);
            if (coll == null) {
                out.append('?');
                flat.add(arg);
                continue;
            }
            String head = out.toString().stripTrailing().toUpperCase();
            if (!head.endsWith("IN (")) {
                throw new IllegalArgumentException("集合参数只能用于 IN (?) 占位符：" + sql);
            }
            if (coll.isEmpty()) {
                out.append("NULL");
            } else {
                boolean first = true;
                for (Object item : coll) {
                    if (!first) {
                        out.append(',');
                    }
                    out.append('?');
                    flat.add(item);
                    first = false;
                }
            }
        }
        if (argIdx != args.length) {
            throw new IllegalArgumentException(
                    "SQL 占位符数量与参数数量不一致：占位符 " + argIdx + " 个，参数 " + args.length + " 个");
        }
        return new Prepared(out.toString(), flat.toArray());
    }

    private static Collection<?> asCollection(Object arg) {
        if (arg instanceof Collection<?> c) {
            return c;
        }
        if (arg instanceof Object[] arr) {
            return java.util.Arrays.asList(arr);
        }
        return null;
    }

    /* ------------------------------------------------------------------ */
    /* 取值助手：数据库返回的可能是 Integer / Long / BigDecimal / String     */
    /* ------------------------------------------------------------------ */

    public static long num(Map<String, Object> row, String key) {
        return toLong(row == null ? null : row.get(key));
    }

    public static Long numOrNull(Map<String, Object> row, String key) {
        Object v = row == null ? null : row.get(key);
        return v == null ? null : toLong(v);
    }

    public static long toLong(Object v) {
        if (v == null) {
            return 0L;
        }
        if (v instanceof Number n) {
            return n.longValue();
        }
        return Long.parseLong(String.valueOf(v));
    }

    public static BigDecimal decimal(Map<String, Object> row, String key) {
        Object v = row == null ? null : row.get(key);
        if (v == null) {
            return BigDecimal.ZERO;
        }
        if (v instanceof BigDecimal b) {
            return b;
        }
        return new BigDecimal(String.valueOf(v));
    }

    public static String str(Map<String, Object> row, String key) {
        Object v = row == null ? null : row.get(key);
        return v == null ? null : String.valueOf(v);
    }

    /** 业务上大量存在"0/1 小整数"语义的列，统一转成 boolean 供判断使用。 */
    public static boolean flag(Map<String, Object> row, String key) {
        return num(row, key) != 0;
    }
}
