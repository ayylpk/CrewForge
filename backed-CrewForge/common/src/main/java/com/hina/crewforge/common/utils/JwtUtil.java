package com.hina.crewforge.common.utils;

import com.hina.crewforge.common.constant.JwtClaimsConstant;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jwts;

import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;
import java.util.Base64;
import java.util.Date;
import java.util.Map;

/**
 * JWT 工具类 — 创建和解析 token
 *
 * 设计决策（简化）：
 * token 里只装 userId（身份标识），不装 tenantId / role ——
 * 团队用请求头 X-Tenant-Id 携带，角色查库获取。
 * 这样切换团队/角色变化都无需重新签发 token。
 */

public class JwtUtil {

    /**
     * 生成 SecretKey
     */
    private static SecretKey getSecretKey(String secret) {
        byte[] keyBytes = Base64.getDecoder().decode(secret);
        return new SecretKeySpec(keyBytes, "HmacSHA256");
    }

    /**
     * 创建 JWT token（只包含 userId）
     * @param secretKey Base64 编码的密钥
     * @param ttl       有效期 (毫秒)
     * @param userId    用户 ID
     */
    public static String createJwt(String secretKey, long ttl, Long userId) {
        SecretKey key = getSecretKey(secretKey);
        return Jwts.builder()
                .claims(Map.of(JwtClaimsConstant.USER_ID, userId))
                .issuedAt(new Date())
                .expiration(new Date(System.currentTimeMillis() + ttl))
                .signWith(key)
                .compact();
    }

    /**
     * 解析 JWT token，返回 Claims
     */
    public static Claims parseJwt(String secretKey, String token) {
        SecretKey key = getSecretKey(secretKey);
        return Jwts.parser()
                .verifyWith(key)
                .build()
                .parseSignedClaims(token)
                .getPayload();
    }
}
