package com.campus.course.config;

import java.io.IOException;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

import org.springframework.boot.autoconfigure.jackson.Jackson2ObjectMapperBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.databind.JsonSerializer;
import com.fasterxml.jackson.databind.SerializerProvider;
import com.fasterxml.jackson.databind.module.SimpleModule;

/**
 * JSON 序列化约定（时间与日期）。
 *
 * <p>数据库里全部是 {@code timestamp without time zone} / {@code date}，
 * JDBC 取出来是 {@link java.sql.Timestamp} 与 {@link java.sql.Date}。
 * 统一序列化成：
 * <ul>
 *   <li>时间 → {@code 2026-09-29T14:12:00}（ISO-8601，前端 {@code new Date(v)} 可直接解析）</li>
 *   <li>日期 → {@code 2026-09-01}</li>
 * </ul>
 *
 * <p>为什么不直接沿用默认的 yyyy-MM-dd HH:mm:ss：带空格的写法在 Safari 等浏览器里
 * {@code new Date()} 会解析失败，前端 fmtTime 就会退化成原样输出，
 * 因此这里明确使用 ISO-8601 带 T 的写法。
 */
@Configuration
public class JacksonConfig {

    private static final DateTimeFormatter DATE_TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss");
    private static final DateTimeFormatter DATE = DateTimeFormatter.ofPattern("yyyy-MM-dd");

    @Bean
    public Jackson2ObjectMapperBuilderCustomizer isoTimeCustomizer() {
        return builder -> {
            SimpleModule module = new SimpleModule("course-selection-iso-time");
            module.addSerializer(java.sql.Timestamp.class, new JsonSerializer<>() {
                @Override
                public void serialize(java.sql.Timestamp value, JsonGenerator gen, SerializerProvider sp)
                        throws IOException {
                    gen.writeString(value.toLocalDateTime().format(DATE_TIME));
                }
            });
            module.addSerializer(java.sql.Date.class, new JsonSerializer<>() {
                @Override
                public void serialize(java.sql.Date value, JsonGenerator gen, SerializerProvider sp)
                        throws IOException {
                    gen.writeString(value.toLocalDate().format(DATE));
                }
            });
            module.addSerializer(LocalDateTime.class, new JsonSerializer<>() {
                @Override
                public void serialize(LocalDateTime value, JsonGenerator gen, SerializerProvider sp)
                        throws IOException {
                    gen.writeString(value.format(DATE_TIME));
                }
            });
            module.addSerializer(LocalDate.class, new JsonSerializer<>() {
                @Override
                public void serialize(LocalDate value, JsonGenerator gen, SerializerProvider sp)
                        throws IOException {
                    gen.writeString(value.format(DATE));
                }
            });
            builder.modulesToInstall(module);
        };
    }
}
