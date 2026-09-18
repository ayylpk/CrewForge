package com.hina.crewforge.service.support;

import com.hina.crewforge.common.context.BaseContext;
import com.hina.crewforge.common.exception.BaseException;
import com.hina.crewforge.mapper.UserMapper;
import com.hina.crewforge.pojo.entity.User;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/**
 * AdminGuard：审计漏洞②（任何登录用户可管用户/重置 admin 密码）与③（settings 全员可写可试）
 * 的共同权限底座。消息刻意含糊（"需要管理员权限"），不给探测者区分"用户不存在/角色不够"的信号。
 */
@ExtendWith(MockitoExtension.class)
class AdminGuardTest {

    @Mock private UserMapper userMapper;
    private AdminGuard guard;

    @BeforeEach
    void setUp() {
        guard = new AdminGuard(userMapper);
        BaseContext.setCurrentUserId(1001L);
    }

    @AfterEach
    void tearDown() {
        BaseContext.remove();
    }

    @Test
    @DisplayName("role=0 管理员 → 放行并返回实体")
    void adminPasses() {
        User u = user(1001L, 0);
        when(userMapper.selectById(1001L)).thenReturn(u);
        assertSame(u, guard.requireAdmin());
    }

    @Test
    @DisplayName("role=1 普通用户 → 拒绝")
    void normalUserRejected() {
        when(userMapper.selectById(1001L)).thenReturn(user(1001L, 1));
        BaseException ex = assertThrows(BaseException.class, () -> guard.requireAdmin());
        assertTrue(ex.getMessage().contains("管理员"));
    }

    @Test
    @DisplayName("role 为 NULL（库里脏行）→ 按最小权限拒绝，不当 0 兜底")
    void nullRoleRejected() {
        when(userMapper.selectById(1001L)).thenReturn(user(1001L, null));
        assertThrows(BaseException.class, guard::requireAdmin);
    }

    @Test
    @DisplayName("用户查不到 → 拒绝")
    void missingUserRejected() {
        when(userMapper.selectById(1001L)).thenReturn(null);
        assertThrows(BaseException.class, guard::requireAdmin);
    }

    @Test
    @DisplayName("无登录态（BaseContext 空）→ 拒绝且【不触库】")
    void notLoggedInRejectedWithoutDbTouch() {
        BaseContext.remove();
        assertThrows(BaseException.class, guard::requireAdmin);
        verifyNoInteractions(userMapper);
    }

    private static User user(Long id, Integer role) {
        User u = new User();
        u.setId(id);
        u.setRole(role);
        return u;
    }
}
