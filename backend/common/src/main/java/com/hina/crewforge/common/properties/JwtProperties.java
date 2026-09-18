package com.hina.crewforge.common.properties;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * JWT 配置属性 — 读取 yml 中 crewforge.jwt.*
 */
@Data
@Component
@ConfigurationProperties(prefix = "crewforge.jwt")
public class JwtProperties {

    /** 管理员端 secret */
    private String adminSecretKey;
    /** 管理员端 token 有效期 (ms) */
    private long adminTtl;
    /** 管理员端 token 名称 */
    private String adminTokenName;

    /** 用户端 secret */
    private String userSecretKey;
    /** 用户端 token 有效期 (ms) */
    private long userTtl;
    /** 用户端 token 名称 */
    private String userTokenName;
}
