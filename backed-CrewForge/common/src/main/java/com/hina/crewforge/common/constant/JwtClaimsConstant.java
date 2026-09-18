package com.hina.crewforge.common.constant;

/**
 * JWT Claims 字段名常量
 *
 * 9/17 清理：删掉 TENANT_ID / ROLE —— token 里只装 userId（见 JwtUtil.createJwt 的
 * `Map.of(USER_ID, userId)`），角色走 AdminGuard 每次查库、租户概念已随团队功能砍掉。
 * 留着这两个常量会让人以为 token 里带角色/租户。
 */
public class JwtClaimsConstant {

    public static final String USER_ID = "userId";

}
