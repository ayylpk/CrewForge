package com.hina.crewforge.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * 全局 CORS 配置 — 开发期允许前端本地调试（端口不同即跨域，浏览器默认拦截）
 * 生产部署时前后端同域，这段可保留（同域请求不受影响）
 */
@Configuration
public class WebConfig implements WebMvcConfigurer {

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/api/**")
                // 只认"本机 + 任意端口"：vite 默认 5173，被占用会自动往上顶（5174/5175…），
                // 且 localhost 与 127.0.0.1 在浏览器眼里是两个 origin。
                // 写死端口列表 = 换个端口就整站 CORS 报错（9/17 实测 5173 被别的项目占着）。
                .allowedOriginPatterns("http://localhost:[*]", "http://127.0.0.1:[*]")
                .allowedMethods("GET", "POST", "PUT", "DELETE", "OPTIONS")
                .allowedHeaders("*")
                .maxAge(3600);
    }
}
