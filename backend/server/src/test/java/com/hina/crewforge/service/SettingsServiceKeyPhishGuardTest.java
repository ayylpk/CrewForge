package com.hina.crewforge.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.hina.crewforge.common.exception.BaseException;
import com.hina.crewforge.mapper.SettingsMapper;
import com.hina.crewforge.pojo.dto.SettingsDTO;
import com.hina.crewforge.pojo.entity.Settings;
import com.hina.crewforge.service.impl.SettingsServiceImpl;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.io.Serializable;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

/**
 * 审计漏洞③（B10）：settings 测试连接端点可以用"掩码 key（=库内真 key）+ 自填 URL"
 * 把真实 api_key 的 Bearer 头钓到任意服务器。
 *
 * 修复口径：掩码回传（用户没改 key）时，测试目标 URL 必须与【落库配置解析后的目标】一致；
 * 想测新端点就当场重填明文 key（用户自己的新 key，发去哪都不涉及库内秘密）。
 *
 * 用例分两类：
 * - 拒绝类：证明闸在拦（修复前 RED）；
 * - "请先填写模型名"类：证明闸【没多拦】——请求通过了安全闸、继续走到了业务校验才停
 *   （该分支不发网络请求，可安全断言；若被闸误拒会变成抛异常/其他错误）。
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class SettingsServiceKeyPhishGuardTest {

    /** 假 key——本测试族验证的是"真 key 会不会被发到别的 URL"，闸在发之前抛，任何用例都不会真发 */
    private static final String DB_KEY = "sk-db-secret-9999";

    @Mock private SettingsMapper settingsMapper;
    private SettingsServiceImpl service;

    @BeforeEach
    void setUp() {
        service = new SettingsServiceImpl(settingsMapper, new ObjectMapper());
    }

    private void stubDb(String kind, String url) {
        Settings s = new Settings();
        s.setId(1);
        s.setModelKind(kind);
        s.setModelUrl(url);
        s.setApiKey(DB_KEY);
        // 注意：生产代码 selectById(ROW_ID) 传的是 int 装箱的 Integer(1)，
        // Mockito 按 equals 匹配 Integer(1)≠Long(1)，所以这里必须 any()，不能写 selectById(1L)
        when(settingsMapper.selectById(any(Serializable.class))).thenReturn(s);
    }

    // ==================== 拒绝类（修复前=RED） ====================

    @Test
    @DisplayName("钓 key 主案：掩码 key + 换掉的 URL → 拒（修复前会把库内真 key 发去这个 URL）")
    void maskedKeyAgainstChangedUrlRejected() {
        stubDb("openai", "http://db.local:11434/v1");
        SettingsDTO dto = dto("openai", "http://api.phishing.invalid:9/v1", "****9999", "some-model");
        BaseException ex = assertThrows(BaseException.class, () -> service.test(dto));
        assertTrue(ex.getMessage().contains("apiKey"), "拒绝原因要指路（重填 key），不能只说无权");
    }

    @Test
    @DisplayName("掩码 key + 把 URL 清空去测官方端点，而库内配置是自建代理 → 同规则拒（方向对称）")
    void maskedKeyClearingUrlRejected() {
        stubDb("deepseek", "https://my-proxy.example.com/v1");
        SettingsDTO dto = dto(null, null, "****9999", "some-model"); // kind/url 都缺省=官方端点
        assertThrows(BaseException.class, () -> service.test(dto));
    }

    // ==================== 不扩拦类（通过闸、停在"请先填写模型名"） ====================

    @Test
    @DisplayName("掩码 key + 与库一致的 URL → 放行到业务校验（正常'原配置测连通'用例不许坏）")
    void maskedKeySameUrlProceeds() {
        stubDb("openai", "http://db.local:11434/v1");
        SettingsDTO dto = dto("openai", "http://db.local:11434/v1", "****9999", null);
        assertProceedsToModelCheck(dto);
    }

    @Test
    @DisplayName("URL 尾斜杠差异归一后视为同一端点（不许因字符串噪音误拒）")
    void maskedKeyTrailingSlashEquivalent() {
        stubDb("openai", "http://db.local:11434/v1/");
        SettingsDTO dto = dto("openai", "http://db.local:11434/v1", "****9999", null);
        assertProceedsToModelCheck(dto);
    }

    @Test
    @DisplayName("明文新 key + 任意 URL → 放行（换端点换 key 的本职用例，不涉及钓库内 key）")
    void plaintextKeyToAnyUrlProceeds() {
        stubDb("openai", "http://db.local:11434/v1");
        SettingsDTO dto = dto("openai", "http://api.phishing.invalid:9/v1", "sk-brand-new-key", null);
        assertProceedsToModelCheck(dto);
    }

    @Test
    @DisplayName("库里没配置行 → 无 key 可钓，掩码也放行（首次配置场景）")
    void maskedKeyWithNoDbRowProceeds() {
        when(settingsMapper.selectById(any(Serializable.class))).thenReturn(null);
        SettingsDTO dto = dto("openai", "http://api.phishing.invalid:9/v1", "****abcd", null);
        assertProceedsToModelCheck(dto);
    }

    @Test
    @DisplayName("db 行存在但 kind/url 全空（=deepseek 默认官方）+ dto 同缺省 → 放行")
    void deepseekDefaultsMatchDbDefaults() {
        stubDb(null, null);
        SettingsDTO dto = dto(null, null, "****9999", null);
        assertProceedsToModelCheck(dto);
    }

    // ==================== 工具 ====================

    /** 断言"已通过安全闸、停在模型名校验"——该早退分支不发任何网络请求 */
    private void assertProceedsToModelCheck(SettingsDTO dto) {
        Map<String, Object> r = assertDoesNotThrow(() -> service.test(dto));
        assertEquals(Boolean.FALSE, r.get("ok"));
        assertEquals("请先填写模型名", r.get("error"));
    }

    private static SettingsDTO dto(String kind, String url, String key, String model) {
        SettingsDTO d = new SettingsDTO();
        d.setModelKind(kind);
        d.setModelUrl(url);
        d.setApiKey(key);
        d.setModelName(model);
        return d;
    }
}
