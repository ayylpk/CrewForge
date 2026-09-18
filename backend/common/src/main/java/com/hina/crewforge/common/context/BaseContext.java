package com.hina.crewforge.common.context;

/**
 * 请求上下文 — 基于 ThreadLocal 传递 userId
 *
 * ⚠️ 砍掉团队功能后：移除 tenantThreadLocal
 */
public class BaseContext {

    private static final ThreadLocal<Long> threadLocal = new ThreadLocal<>();

    public static void setCurrentUserId(Long id) {
        threadLocal.set(id);
    }

    public static Long getCurrentUserId() {
        return threadLocal.get();
    }

    public static void remove() {
        threadLocal.remove();
    }
}
