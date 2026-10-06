package com.campus.course.web;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ThreadLocalRandom;

import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.campus.course.common.Api;
import com.campus.course.common.ApiResponse;
import com.campus.course.common.BizException;
import com.campus.course.common.ErrorCode;
import com.campus.course.config.AppProperties;
import com.campus.course.db.Db;
import com.campus.course.security.CurrentUser;
import com.campus.course.security.SessionStore;
import com.campus.course.security.TokenService;
import com.campus.course.service.AccountService;
import com.campus.course.service.AuditService;

import jakarta.servlet.http.HttpServletRequest;

/**
 * 认证接口（对应设计文档表 4 核心接口清单、3.2.1 登录页）。
 *
 * <p>登录连续失败 5 次触发算式验证码（图形验证码的等价可用性设计）。
 * 口令使用 BCrypt 加盐哈希校验，数据库中不保存明文。
 */
@RestController
@RequestMapping("/api/auth")
public class AuthController {

    /** 验证码有效期 3 分钟 */
    private static final long CAPTCHA_TTL_MILLIS = 3 * 60 * 1000L;

    private record Captcha(int answer, long expire) {
    }

    private final AccountService account;
    private final AuditService audit;
    private final TokenService tokens;
    private final SessionStore sessions;
    private final Db db;
    private final AppProperties props;
    private final BCryptPasswordEncoder encoder = new BCryptPasswordEncoder();

    /** 账号 → 连续失败次数 */
    private final Map<String, Integer> loginFailures = new ConcurrentHashMap<>();
    /** 验证码 id → 答案与过期时间 */
    private final Map<String, Captcha> captchas = new ConcurrentHashMap<>();

    public AuthController(AccountService account, AuditService audit, TokenService tokens,
                          SessionStore sessions, Db db, AppProperties props) {
        this.account = account;
        this.audit = audit;
        this.tokens = tokens;
        this.sessions = sessions;
        this.db = db;
        this.props = props;
    }

    /** 获取算式验证码 */
    @GetMapping("/captcha")
    public ApiResponse captcha() {
        ThreadLocalRandom rnd = ThreadLocalRandom.current();
        int a = rnd.nextInt(2, 19);
        int b = rnd.nextInt(1, 9);
        boolean plus = rnd.nextInt(0, 2) == 1;
        int answer = plus ? a + b : a - b;
        String id = UUID.randomUUID().toString();
        captchas.put(id, new Captcha(answer, System.currentTimeMillis() + CAPTCHA_TTL_MILLIS));

        Map<String, Object> data = new java.util.LinkedHashMap<>();
        data.put("captchaId", id);
        // U+2212 减号，避免与连字符混淆
        data.put("question", a + (plus ? " + " : " − ") + b + " = ?");
        return Api.ok(data);
    }

    /** 登录 */
    @PostMapping("/login")
    public ApiResponse login(@RequestBody(required = false) Map<String, Object> body,
                             HttpServletRequest request) {
        Map<String, Object> b = body == null ? Map.of() : body;
        String username = Api.strOf(b.get("username"));
        String password = b.get("password") == null ? null : String.valueOf(b.get("password"));
        String captchaId = Api.strOf(b.get("captchaId"));
        Object captchaAnswer = b.get("captchaAnswer");

        if (username == null || password == null || password.isEmpty()) {
            throw new BizException(ErrorCode.BAD_REQUEST, "请输入账号与密码");
        }

        int captchaAfter = props.getAuth().getCaptchaAfterFailures();
        if (loginFailures.getOrDefault(username, 0) >= captchaAfter) {
            Captcha item = captchaId == null ? null : captchas.get(captchaId);
            int answer = Api.intOf(captchaAnswer, Integer.MIN_VALUE);
            boolean valid = item != null
                    && item.expire() > System.currentTimeMillis()
                    && answer == item.answer();
            if (captchaId != null) {
                captchas.remove(captchaId);
            }
            if (!valid) {
                return Api.fail(ErrorCode.LOGIN_FAILED, "请输入正确的验证码",
                        Map.of("needCaptcha", true));
            }
        }

        Map<String, Object> user = account.getUserByUsername(username);
        if (user == null || !verifyPassword(password, Db.str(user, "password_hash"))) {
            int count = loginFailures.merge(username, 1, Integer::sum);
            audit.logAs(null, null, AuditService.clientIp(request), "LOGIN", "USER", null, 0,
                    "账号或密码错误：" + username + "（连续失败 " + count + " 次）");
            return Api.fail(ErrorCode.LOGIN_FAILED, null,
                    Map.of("needCaptcha", count >= captchaAfter));
        }
        if (Db.num(user, "status") != 1) {
            return Api.fail(ErrorCode.NO_PERMISSION, "账号已被禁用，请联系系统管理员", null);
        }

        loginFailures.remove(username);
        db.update("UPDATE t_user SET last_login_at = NOW() WHERE id = ?", Db.num(user, "id"));

        Map<String, Object> profile = account.buildProfile(user);
        TokenService.Signed signed = tokens.sign(
                Db.num(user, "id"), Db.str(user, "username"), Db.str(user, "real_name"),
                (int) Db.num(user, "role"));
        sessions.create(signed.payload());

        audit.logAs(Db.num(user, "id"), Db.str(user, "username"), AuditService.clientIp(request),
                "LOGIN", "USER", Db.num(user, "id"), 1, "登录成功");

        Map<String, Object> data = new java.util.LinkedHashMap<>();
        data.put("token", signed.token());
        data.put("expiresInMinutes", props.getAuth().getIdleTimeoutMinutes());
        data.put("profile", profile);
        return Api.ok(data);
    }

    /** 注销：直接销毁服务端会话，令牌立即失效（不等自然过期） */
    @PostMapping("/logout")
    public ApiResponse logout() {
        sessions.destroy(CurrentUser.require().jti());
        return Api.ok(Map.of("logout", true));
    }

    /** 当前用户信息与角色 */
    @GetMapping("/me")
    public ApiResponse me() {
        long userId = CurrentUser.userId();
        Map<String, Object> user = account.getUserById(userId);
        Map<String, Object> profile = account.buildProfile(user);
        Map<String, Object> unread = db.queryOne(
                "SELECT COUNT(*) AS cnt FROM t_notice WHERE user_id = ? AND is_read = 0", userId);

        Map<String, Object> data = new java.util.LinkedHashMap<>();
        data.put("profile", profile);
        data.put("unreadNotice", unread == null ? 0L : Db.num(unread, "cnt"));
        return Api.ok(data);
    }

    /** BCrypt 校验；数据库里是 bcrypt 哈希，禁止明文或可逆加密（设计文档 7.3） */
    private boolean verifyPassword(String plain, String hashed) {
        if (hashed == null || hashed.isEmpty()) {
            return false;
        }
        try {
            return encoder.matches(plain, hashed);
        } catch (Exception e) {
            return false;
        }
    }

    /** 供 DbInitializer 生成演示口令哈希使用 */
    public static String hashPassword(String plain) {
        return new BCryptPasswordEncoder().encode(plain);
    }

    /** 便于测试与运维排查时清空失败计数 */
    Map<String, Integer> failureCounters() {
        return new HashMap<>(loginFailures);
    }
}
