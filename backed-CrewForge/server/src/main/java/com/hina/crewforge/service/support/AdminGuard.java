package com.hina.crewforge.service.support;

import com.hina.crewforge.common.context.BaseContext;
import com.hina.crewforge.common.exception.BaseException;
import com.hina.crewforge.mapper.UserMapper;
import com.hina.crewforge.pojo.entity.User;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/**
 * 管理员门卫（9/16 审计漏洞②③ 的权限底座）
 *
 * 用法：管理端点（settings 保存/测试连接等）首行 adminGuard.requireAdmin()，一行完成"登录+角色"两检。
 *
 * 口径说明（相对拍板文案"token 带 role claim"的实现偏差，已论证）：
 * - 角色【每次查库】而非从 JWT claim 读——角色变更即时生效、不用重登录，
 *   且零侵入登录/签发链路（现在 token 只含 userId）；管理端点低频，多一次主键查询无感。
 * - 与 ProjectGuard 同目录同风格：requireXxx 失败即抛 BaseException，全局异常处理器统一出口。
 */
@Component
@RequiredArgsConstructor
public class AdminGuard {

    /** sys_user.role：0=管理员（与 migration_rbac_admin.sql 对齐） */
    public static final int ROLE_ADMIN = 0;

    private final UserMapper userMapper;

    /** 当前登录用户必须是管理员；返回其实体供调用方继续用 */
    public User requireAdmin() {
        Long userId = BaseContext.getCurrentUserId();
        if (userId == null) {
            // 没登录态就绝不触库——防"userId=null 查全表第一行"式的野路子放行
            throw new BaseException("需要管理员权限");
        }
        User user = userMapper.selectById(userId);
        if (user == null) {
            throw new BaseException("需要管理员权限");
        }
        if (user.getRole() == null || user.getRole() != ROLE_ADMIN) {
            throw new BaseException("需要管理员权限");
        }
        return user;
    }
}
