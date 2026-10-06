package com.campus.course.init;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;

import javax.sql.DataSource;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.datasource.init.ScriptUtils;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Component;

import com.campus.course.config.AppProperties;

/**
 * 数据库初始化（等价于原 Node 版的 scripts/init-db.js 与 {@code npm run db:init}）。
 *
 * <p>默认关闭，只有显式打开 {@code app.db.init-on-startup=true}（对应环境变量 {@code DB_INIT=true}）
 * 或运行时传 {@code --app.db.init-on-startup=true} 才会执行：
 * <ol>
 *   <li>执行 {@code db/schema-pg.sql}：先 DROP 再 CREATE，共 18 张表 + 1 个触发器函数 + 18 个触发器；</li>
 *   <li>把 {@code db/seed-pg.sql} 里的 {@code __PWD_HASH__} 占位符替换成演示口令的 BCrypt 哈希后导入，
 *       源码与脚本里都不出现明文口令；</li>
 *   <li>校正自增序列（种子脚本显式写入了主键）。</li>
 * </ol>
 *
 * <p><b>注意</b>：这是"重建库"操作，会清空现有数据，只在首次部署或重置演示环境时使用。
 */
@Component
public class DbInitializer implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(DbInitializer.class);

    /** 演示账号统一口令；仅用于本地演示与验收环境 */
    private static final String DEMO_PASSWORD = "123456";
    private static final String PWD_PLACEHOLDER = "__PWD_HASH__";

    private final DataSource dataSource;
    private final AppProperties props;

    public DbInitializer(DataSource dataSource, AppProperties props) {
        this.dataSource = dataSource;
        this.props = props;
    }

    @Override
    public void run(ApplicationArguments args) throws Exception {
        if (!props.getDb().isInitOnStartup()) {
            log.info("数据库初始化已跳过（app.db.init-on-startup=false）；"
                    + "如需重建演示库，请加 --app.db.init-on-startup=true 启动");
            return;
        }

        log.warn("开始重建数据库结构并导入演示数据（会先删除同名的 18 张表）...");
        String schema = read("db/schema-pg.sql");
        String seed = read("db/seed-pg.sql")
                .replace(PWD_PLACEHOLDER, new BCryptPasswordEncoder().encode(DEMO_PASSWORD));

        try (Connection conn = dataSource.getConnection()) {
            ScriptUtils.executeSqlScript(conn, new org.springframework.core.io.ByteArrayResource(
                    schema.getBytes(StandardCharsets.UTF_8)));
            log.info("表结构与触发器已创建");
            ScriptUtils.executeSqlScript(conn, new org.springframework.core.io.ByteArrayResource(
                    seed.getBytes(StandardCharsets.UTF_8)));
            log.info("演示数据已导入（14 个演示账号，口令见 README「演示账号」一节）");
        }
        log.warn("数据库初始化完成。生产环境请把 app.db.init-on-startup 改回 false。");
    }

    private String read(String classpath) throws Exception {
        ClassPathResource resource = new ClassPathResource(classpath);
        try (InputStream in = resource.getInputStream()) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }
}
