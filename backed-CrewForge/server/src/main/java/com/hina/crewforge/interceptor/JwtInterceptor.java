package com.hina.crewforge.interceptor;

import com.hina.crewforge.common.constant.JwtClaimsConstant;
import com.hina.crewforge.common.context.BaseContext;
import com.hina.crewforge.common.properties.JwtProperties;
import com.hina.crewforge.common.utils.JwtUtil;
import io.jsonwebtoken.Claims;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;

/**
 * JWT 令牌拦截器 — 校验所有请求的 token
 *
 * ⚠️ 砍掉团队功能后：移除 X-Tenant-Id 校验逻辑
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class JwtInterceptor implements HandlerInterceptor {

    private final JwtProperties jwtProperties;

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) throws Exception {
        // 非 Controller 方法（静态资源等）直接放行
        if (!(handler instanceof HandlerMethod)) {
            return true;
        }

        // 1. 从请求头获取 token
        String token = request.getHeader(jwtProperties.getUserTokenName());

        // 2. 解析 token（先 user 密钥，再 admin 密钥）
        try {
            Claims claims = parseWithFallback(token);
            Long userId = Long.valueOf(claims.get(JwtClaimsConstant.USER_ID).toString());
            BaseContext.setCurrentUserId(userId);
            log.debug("JWT 校验通过: userId={}", userId);
        } catch (Exception ex) {
            log.warn("JWT 校验失败: {}", ex.getMessage());
            response.setStatus(401);
            response.setContentType("application/json;charset=UTF-8");
            response.getWriter().write("{\"code\":0,\"msg\":\"未登录或token已过期\"}");
            return false;
        }

        return true;
    }


    /**
     * 双密钥解析：先 user 密钥，失败换 admin 密钥
     */
    private Claims parseWithFallback(String token) {
        try {
            return JwtUtil.parseJwt(jwtProperties.getUserSecretKey(), token);
        } catch (Exception e) {
            return JwtUtil.parseJwt(jwtProperties.getAdminSecretKey(), token);
        }
    }

    @Override
    public void afterCompletion(HttpServletRequest request, HttpServletResponse response,
                                Object handler, Exception ex) {
        BaseContext.remove();
    }
}
