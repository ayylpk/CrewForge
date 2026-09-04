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
