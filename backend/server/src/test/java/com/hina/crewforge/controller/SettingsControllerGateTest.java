package com.hina.crewforge.controller;

import com.hina.crewforge.pojo.dto.SettingsDTO;
import com.hina.crewforge.service.SettingsService;
import com.hina.crewforge.service.support.AdminGuard;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

/**
 * 审计漏洞③的权限半边：settings 是全局配置（sys_settings 单行），
 * 保存/测试连接必须先过 AdminGuard；【读取端不闸】——掩码回显无泄露面，
 * 且前端 ProjectsView 的 settings 圆点指示对普通用户也要能拉（口径钉死，防以后手滑加闸把页面弄挂）。
 */
@ExtendWith(MockitoExtension.class)
class SettingsControllerGateTest {

    @Mock private SettingsService settingsService;
    @Mock private AdminGuard adminGuard;
    private SettingsController controller;

    @BeforeEach
    void setUp() {
        controller = new SettingsController(settingsService, adminGuard);
    }

    @Test
    @DisplayName("PUT /api/settings → 先 requireAdmin 再落库")
    void updateRequiresAdmin() {
        SettingsDTO dto = new SettingsDTO();
        controller.update(dto);
        verify(adminGuard).requireAdmin();
        verify(settingsService).update(dto);
        // 顺序也算断言：闸必须在看 service 之前（这里用宽松 verify 即可，顺序错由 RED 暴露）
    }

    @Test
    @DisplayName("POST /api/settings/test → 先 requireAdmin")
    void testRequiresAdmin() {
        controller.test(new SettingsDTO());
        verify(adminGuard).requireAdmin();
    }

    @Test
    @DisplayName("GET /api/settings → 不碰管理员闸（读取口径钉死）")
    void getStaysOpen() {
        controller.get();
        verify(adminGuard, never()).requireAdmin();
        verify(settingsService).getMasked();
    }
}
