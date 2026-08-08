package com.hina.crewforge.interceptor;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.hina.crewforge.common.constant.JwtClaimsConstant;
import com.hina.crewforge.common.context.BaseContext;
import com.hina.crewforge.common.properties.JwtProperties;
import com.hina.crewforge.common.utils.JwtUtil;
import com.hina.crewforge.mapper.UserTenantMapper;
import com.hina.crewforge.pojo.entity.UserTenant;
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
 * 设计（简化）：
 * · token 只含 userId，解析后写入 BaseContext（ThreadLocal）
 * · 团队(tenantId) 从请求头 X-Tenant-Id 读取，写入 BaseContext —— 切换团队无需重新登录
 * · 先试用户端密钥，失败再试管理端密钥（兼容未来的管理端 token）
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class JwtInterceptor implements HandlerInterceptor {

    /** 团队 ID 请求头名称 */
    public static final String TENANT_HEADER = "X-Tenant-Id";

    private final JwtProperties jwtProperties;

    /** 成员关系表（校验 X-Tenant-Id 归属用） */
    private final UserTenantMapper userTenantMapper;

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) throws Exception {
        // 非 Controller 方法（静态资源等）直接放行
        if (!(handler instanceof HandlerMethod)) {
            return true;
        }

        // 1. 从请求头获取 token
        String token = request.getHeader(jwtProperties.getUserTokenName());

        // 2. 解析 token（先 user 密钥，再 admin 密钥）
        Long userId = null;
        try {
            Claims claims = parseWithFallback(token);
            userId = Long.valueOf(claims.get(JwtClaimsConstant.USER_ID).toString());
            BaseContext.setCurrentUserId(userId);
            log.debug("JWT 校验通过: userId={}", userId);
        } catch (Exception ex) {
            log.warn("JWT 校验失败: {}", ex.getMessage());
            response.setStatus(401);
            response.setContentType("application/json;charset=UTF-8");
            response.getWriter().write("{\"code\":0,\"msg\":\"未登录或token已过期\"}");
            return false;
        }

        // 3. 团队 ID 从请求头读取（多团队切换，无需重新签发 token）
        // ⚠️ 传了就必须属于该团队（sys_user_tenant 正常成员），防伪造头越权
        String tenantIdHeader = request.getHeader(TENANT_HEADER);
        if (tenantIdHeader != null && !tenantIdHeader.isEmpty()) {
            try {
                Long tenantId = Long.valueOf(tenantIdHeader);
                Long memberCount = userTenantMapper.selectCount(new LambdaQueryWrapper<UserTenant>()
                        .eq(UserTenant::getUserId, userId)
                        .eq(UserTenant::getTenantId, tenantId)
                        .eq(UserTenant::getStatus, 1));
                if (memberCount == null || memberCount == 0) {
                    log.warn("X-Tenant-Id 越权拦截: userId={}, tenantId={}", userId, tenantId);
                    response.setStatus(403);
                    response.setContentType("application/json;charset=UTF-8");
                    response.getWriter().write("{\"code\":0,\"msg\":\"你不属于该团队\"}");
                    return false;
                }
                BaseContext.setCurrentTenantId(tenantId);
            } catch (NumberFormatException e) {
                log.warn("X-Tenant-Id 格式错误: {}", tenantIdHeader);
            }
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
        // 清空 ThreadLocal，防止线程池复用导致串数据
        BaseContext.remove();
    }
}
