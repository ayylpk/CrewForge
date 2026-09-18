package com.hina.crewforge.config;

import com.hina.crewforge.interceptor.JwtInterceptor;
import lombok.RequiredArgsConstructor;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * WebMvc 配置 — 注册 JWT 拦截器并配置放行路径
 */
@Configuration
@RequiredArgsConstructor
public class WebMvcConfig implements WebMvcConfigurer {

    private final JwtInterceptor jwtInterceptor;

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(jwtInterceptor)
                .addPathPatterns("/**")
                .excludePathPatterns(
                        // 登录接口
                        "/api/auth/login",
                        // Agent 运行时（classes）写库后清缓存的回调（无 JWT，仅清缓存无副作用）
                        "/api/projectfile/cache/**",
                        // 确认门引擎侧（阶段 3，v2 事实 F2：引擎 spawn 无 token，新接口必须走豁免组）
                        //   ⚠️ 只豁免 engine/**；Web 问答侧（pending/answer）仍需 JWT
                        "/api/confirm/engine/**",
                        // 权限判定引擎侧（9/18）：跑命令的那一端（引擎/testAgent）手里才有命令原文，
                        //   而规则真相在库里 —— 让它问 Java（匹配只有一份实现），所以要无 token 可达。
                        //   ⚠️ 同样只豁免 engine/**；规则的增删改查（/api/permission/rules）仍需 JWT。
                        "/api/permission/engine/**",
                        // knife4j / swagger 文档
                        "/doc.html",
                        "/webjars/**",
                        "/v3/api-docs/**",
                        "/swagger-resources/**",
                        "/favicon.ico",
                        "/error"
                );
    }
}
