package com.campus.course.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * 业务配置（对应 application.yml 的 app.* 节点，可用环境变量覆盖）。
 */
@Component
@ConfigurationProperties(prefix = "app")
public class AppProperties {

    private final Auth auth = new Auth();
    private final RateLimit rateLimit = new RateLimit();
    private final Business business = new Business();
    private final Cors cors = new Cors();
    private final Db db = new Db();
    private int idempotencyTtlMinutes = 5;

    public static class Auth {
        /** 会话令牌签名密钥 */
        private String secret = "course-selection-dev-secret-please-override";
        /** 会话空闲超时（分钟） */
        private int idleTimeoutMinutes = 30;
        /** 登录连续失败达到该次数后要求验证码 */
        private int captchaAfterFailures = 5;

        public String getSecret() {
            return secret;
        }

        public void setSecret(String secret) {
            this.secret = secret;
        }

        public int getIdleTimeoutMinutes() {
            return idleTimeoutMinutes;
        }

        public void setIdleTimeoutMinutes(int idleTimeoutMinutes) {
            this.idleTimeoutMinutes = idleTimeoutMinutes;
        }

        public int getCaptchaAfterFailures() {
            return captchaAfterFailures;
        }

        public void setCaptchaAfterFailures(int captchaAfterFailures) {
            this.captchaAfterFailures = captchaAfterFailures;
        }
    }

    public static class RateLimit {
        private int windowSeconds = 60;
        private int softLimit = 10;
        private int hardLimit = 20;

        public int getWindowSeconds() {
            return windowSeconds;
        }

        public void setWindowSeconds(int windowSeconds) {
            this.windowSeconds = windowSeconds;
        }

        public int getSoftLimit() {
            return softLimit;
        }

        public void setSoftLimit(int softLimit) {
            this.softLimit = softLimit;
        }

        public int getHardLimit() {
            return hardLimit;
        }

        public void setHardLimit(int hardLimit) {
            this.hardLimit = hardLimit;
        }
    }

    public static class Business {
        private int waitlistConfirmHours = 24;
        private int dropDeadlineDaysAfterBatch = 7;

        public int getWaitlistConfirmHours() {
            return waitlistConfirmHours;
        }

        public void setWaitlistConfirmHours(int waitlistConfirmHours) {
            this.waitlistConfirmHours = waitlistConfirmHours;
        }

        public int getDropDeadlineDaysAfterBatch() {
            return dropDeadlineDaysAfterBatch;
        }

        public void setDropDeadlineDaysAfterBatch(int dropDeadlineDaysAfterBatch) {
            this.dropDeadlineDaysAfterBatch = dropDeadlineDaysAfterBatch;
        }
    }

    public static class Cors {
        /** 允许的前端来源，逗号分隔；* 表示放行任意来源 */
        private String allowedOrigins = "*";

        public String getAllowedOrigins() {
            return allowedOrigins;
        }

        public void setAllowedOrigins(String allowedOrigins) {
            this.allowedOrigins = allowedOrigins;
        }
    }

    public static class Db {
        /** 启动时是否自动建表并导入种子数据 */
        private boolean initOnStartup = false;

        public boolean isInitOnStartup() {
            return initOnStartup;
        }

        public void setInitOnStartup(boolean initOnStartup) {
            this.initOnStartup = initOnStartup;
        }
    }

    public Auth getAuth() {
        return auth;
    }

    public RateLimit getRateLimit() {
        return rateLimit;
    }

    public Business getBusiness() {
        return business;
    }

    public Cors getCors() {
        return cors;
    }

    public Db getDb() {
        return db;
    }

    public int getIdempotencyTtlMinutes() {
        return idempotencyTtlMinutes;
    }

    public void setIdempotencyTtlMinutes(int idempotencyTtlMinutes) {
        this.idempotencyTtlMinutes = idempotencyTtlMinutes;
    }
}
