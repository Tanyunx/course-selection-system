package com.campus.course.security;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

import org.springframework.stereotype.Component;

import com.campus.course.config.AppProperties;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * 会话令牌：HMAC-SHA256 签名的自包含令牌（JWT 结构，只用到 JDK 自带能力，无第三方依赖）。
 *
 * <p>载荷含 userId / username / realName / role / iat / exp / jti；
 * 服务端另存一份会话记录（见 {@link SessionStore}），用于注销与空闲超时。
 * 签名算法与载荷字段与原 Node 版 utils/token.js 完全一致。
 */
@Component
public class TokenService {

    /** 令牌载荷 */
    public record Payload(long userId, String username, String realName, int role,
                          long iat, long exp, String jti) {
    }

    public record Signed(String token, Payload payload) {
    }

    private static final Base64.Encoder ENC = Base64.getUrlEncoder().withoutPadding();
    private static final Base64.Decoder DEC = Base64.getUrlDecoder();

    private final ObjectMapper json;
    private final byte[] secret;
    private final int ttlMinutes;

    public TokenService(ObjectMapper json, AppProperties props) {
        this.json = json;
        this.secret = props.getAuth().getSecret().getBytes(StandardCharsets.UTF_8);
        this.ttlMinutes = props.getAuth().getIdleTimeoutMinutes();
    }

    /** 签发令牌。 */
    public Signed sign(long userId, String username, String realName, int role) {
        long now = System.currentTimeMillis();
        long exp = now + ttlMinutes * 60L * 1000L;
        String jti = UUID.randomUUID().toString();

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("userId", userId);
        body.put("username", username);
        body.put("realName", realName);
        body.put("role", role);
        body.put("iat", now);
        body.put("exp", exp);
        body.put("jti", jti);

        String head = b64("{\"alg\":\"HS256\",\"typ\":\"JWT\"}".getBytes(StandardCharsets.UTF_8));
        String data = b64(writeJson(body).getBytes(StandardCharsets.UTF_8));
        String sig = b64(hmac(head + "." + data));

        Payload payload = new Payload(userId, username, realName, role, now, exp, jti);
        return new Signed(head + "." + data + "." + sig, payload);
    }

    /** 校验令牌签名与有效期，失败返回 null。 */
    public Payload verify(String token) {
        if (token == null || token.isEmpty()) {
            return null;
        }
        String[] parts = token.split("\\.");
        if (parts.length != 3) {
            return null;
        }
        String expect = b64(hmac(parts[0] + "." + parts[1]));
        // 定长比较，避免通过响应时间差异逐字节猜测签名
        if (!MessageDigest.isEqual(expect.getBytes(StandardCharsets.UTF_8),
                parts[2].getBytes(StandardCharsets.UTF_8))) {
            return null;
        }
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> body = json.readValue(
                    new String(DEC.decode(parts[1]), StandardCharsets.UTF_8), Map.class);
            long exp = ((Number) body.get("exp")).longValue();
            if (System.currentTimeMillis() > exp) {
                return null;
            }
            return new Payload(
                    ((Number) body.get("userId")).longValue(),
                    (String) body.get("username"),
                    (String) body.get("realName"),
                    ((Number) body.get("role")).intValue(),
                    ((Number) body.get("iat")).longValue(),
                    exp,
                    (String) body.get("jti"));
        } catch (Exception e) {
            return null;
        }
    }

    private String writeJson(Map<String, Object> body) {
        try {
            return json.writeValueAsString(body);
        } catch (Exception e) {
            throw new IllegalStateException("令牌载荷序列化失败", e);
        }
    }

    private String b64(byte[] raw) {
        return ENC.encodeToString(raw);
    }

    private byte[] hmac(String text) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret, "HmacSHA256"));
            return mac.doFinal(text.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new IllegalStateException("令牌签名失败", e);
        }
    }
}
