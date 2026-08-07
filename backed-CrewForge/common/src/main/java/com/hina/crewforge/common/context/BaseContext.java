package com.hina.crewforge.common.context;

/**
 * 请求上下文 — 基于 ThreadLocal 传递 userId / tenantId / role
 */
public class BaseContext {

    private static final ThreadLocal<Long> threadLocal = new ThreadLocal<>();
    private static final ThreadLocal<Long> tenantThreadLocal = new ThreadLocal<>();
    private static final ThreadLocal<Integer> roleThreadLocal = new ThreadLocal<>();

    public static void setCurrentUserId(Long id) {
        threadLocal.set(id);
    }

    public static Long getCurrentUserId() {
        return threadLocal.get();
    }

    public static void setCurrentTenantId(Long tenantId) {
        tenantThreadLocal.set(tenantId);
    }

    public static Long getCurrentTenantId() {
        return tenantThreadLocal.get();
    }

    public static void setCurrentRole(Integer role) {
        roleThreadLocal.set(role);
    }

    public static Integer getCurrentRole() {
        return roleThreadLocal.get();
    }

    public static void remove() {
        threadLocal.remove();
        tenantThreadLocal.remove();
        roleThreadLocal.remove();
    }
}
