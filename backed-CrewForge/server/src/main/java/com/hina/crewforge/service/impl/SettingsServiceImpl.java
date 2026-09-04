package com.hina.crewforge.service.impl;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.hina.crewforge.common.exception.BaseException;
import com.hina.crewforge.mapper.SettingsMapper;
import com.hina.crewforge.pojo.dto.SettingsDTO;
import com.hina.crewforge.pojo.entity.Settings;
import com.hina.crewforge.service.SettingsService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 运行时设置服务实现（sys_settings 单行 id=1）
 *
 * 安全口径：apiKey 只进不出——getMasked 永远掩码回显，update 收到掩码/空值时保留库中原 key。
 * 测试连接用 JDK HttpClient 发 1-token 最小对话（无外部依赖，deepseek/openai 两路都走 /chat/completions 形状）。
 */
@Service
@Slf4j
@RequiredArgsConstructor
public class SettingsServiceImpl implements SettingsService {

    private static final int ROW_ID = 1;

    private final SettingsMapper settingsMapper;
    private final ObjectMapper objectMapper;

    @Override
    public Map<String, Object> getMasked() {
        Settings s = settingsMapper.selectById(ROW_ID);
        Map<String, Object> m = new HashMap<>();
        if (s == null) {
            return m;   // 空配置（首次/未跑种子）→ 前端表单留默认
        }
        m.put("modelName", s.getModelName());
        m.put("modelUrl", s.getModelUrl());
        m.put("modelKind", s.getModelKind());
        m.put("apiKey", mask(s.getApiKey()));          // ★ 只回显掩码，不回明文
        m.put("javaBaseUrl", s.getJavaBaseUrl());
        m.put("confirmTimeoutMin", s.getConfirmTimeoutMin());
        m.put("smokeBuild", s.getSmokeBuild() != null && s.getSmokeBuild() == 1);
        return m;
    }

    @Override
    public void update(SettingsDTO dto) {
        if (dto.getModelKind() != null && !List.of("deepseek", "openai").contains(dto.getModelKind())) {
            throw new BaseException("model_kind 只能是 deepseek 或 openai");
        }
        Settings s = settingsMapper.selectById(ROW_ID);
        boolean isNew = s == null;
        if (isNew) {
            s = new Settings();
            s.setId(ROW_ID);
        }
        if (dto.getModelName() != null) s.setModelName(blankToNull(dto.getModelName()));
        if (dto.getModelUrl() != null) s.setModelUrl(blankToNull(dto.getModelUrl()));
        if (dto.getModelKind() != null) s.setModelKind(dto.getModelKind());
        // apiKey：掩码占位符（前端原样回传）或空 = 不动库里已有的；带 * 或 "****" 开头视为未修改
        if (dto.getApiKey() != null && !isMasked(dto.getApiKey())) {
            s.setApiKey(blankToNull(dto.getApiKey()));
        }
        if (dto.getJavaBaseUrl() != null) {
            String base = blankToNull(dto.getJavaBaseUrl());
            if (base != null && !base.startsWith("http")) throw new BaseException("java_base_url 需以 http 开头");
            s.setJavaBaseUrl(base == null ? "http://localhost:8080" : trimTrailingSlash(base));
        }
        if (dto.getConfirmTimeoutMin() != null) {
            int min = dto.getConfirmTimeoutMin();
            if (min < 1 || min > 720) throw new BaseException("确认门超时需在 1~720 分钟之间");
            s.setConfirmTimeoutMin(min);
        }
        if (dto.getSmokeBuild() != null) s.setSmokeBuild(dto.getSmokeBuild() ? 1 : 0);

        // openai 路必须有 baseURL；deepseek 路留空=官方端点
        if ("openai".equals(s.getModelKind()) && (s.getModelUrl() == null || s.getModelUrl().isBlank())) {
            throw new BaseException("openai 兼容端点需填 baseURL（如 http://localhost:11434/v1）");
        }
        if (isNew) {
            settingsMapper.insert(s);
        } else {
            settingsMapper.updateById(s);
        }
        log.info("sys_settings 已更新（kind={} model={} url={}），引擎侧 30s 内生效",
                s.getModelKind(), s.getModelName(), s.getModelUrl());
    }

    @Override
    public Map<String, Object> test(SettingsDTO dto) {
        Map<String, Object> r = new HashMap<>();
        String kind = dto.getModelKind() == null ? "deepseek" : dto.getModelKind();
        String url = resolveTestUrl(kind, dto.getModelUrl());
        String key = isMasked(dto.getApiKey()) ? currentKey() : blankToNull(dto.getApiKey());
        // 没配 key 时：deepseek 路引擎会用 .env 兜底，测试这边也允许空 key（部分本地端点无鉴权）→ 用占位
        String auth = key == null ? "not-needed" : key;
        String model = blankToNull(dto.getModelName());
        if (model == null) {
            r.put("ok", false);
            r.put("error", "请先填写模型名");
            return r;
        }
        long t0 = System.currentTimeMillis();
        try {
            String body = objectMapper.writeValueAsString(Map.of(
                    "model", model,
                    "messages", List.of(Map.of("role", "user", "content", "ping")),
                    "max_tokens", 1));
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .timeout(Duration.ofSeconds(20))
                    .header("Content-Type", "application/json")
                    .header("Authorization", "Bearer " + auth)
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .build();
            HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
            HttpResponse<String> resp = client.send(req, HttpResponse.BodyHandlers.ofString());
            r.put("status", resp.statusCode());
            r.put("latencyMs", System.currentTimeMillis() - t0);
            if (resp.statusCode() >= 200 && resp.statusCode() < 300) {
                r.put("ok", true);
            } else {
                r.put("ok", false);
                r.put("error", "HTTP " + resp.statusCode() + "：" + brief(resp.body()));
            }
        } catch (Exception e) {
            r.put("ok", false);
            r.put("latencyMs", System.currentTimeMillis() - t0);
            r.put("error", e.getClass().getSimpleName() + ": " + e.getMessage());
        }
        return r;
    }

    // ==================== 小工具 ====================

    /** 测试端点：openai 用填的 url，deepseek 用官方 chat 端点（url 尾斜杠归一后补 /chat/completions） */
    private String resolveTestUrl(String kind, String modelUrl) {
        if ("openai".equals(kind)) {
            String base = blankToNull(modelUrl);
            if (base == null) throw new BaseException("openai 兼容端点需填 baseURL 再测");
            if (base.endsWith("/chat/completions")) return base;
            return trimTrailingSlash(base) + "/chat/completions";
        }
        String base = blankToNull(modelUrl) == null ? "https://api.deepseek.com/v1" : trimTrailingSlash(modelUrl);
        return base + "/chat/completions";
    }

    private String currentKey() {
        Settings s = settingsMapper.selectById(ROW_ID);
        return s == null ? null : s.getApiKey();
    }

    /** 掩码值判定：前端把回显的 ****xxxxx 原样传回 = 用户没改 key */
    private boolean isMasked(String key) {
        return key == null || key.isBlank() || key.startsWith("****");
    }

    private String mask(String key) {
        if (key == null || key.isBlank()) return null;
        if (key.length() <= 4) return "****";
        return "****" + key.substring(key.length() - 4);
    }

    private String blankToNull(String v) {
        return v == null || v.isBlank() ? null : v.trim();
    }

    private String trimTrailingSlash(String v) {
        return v.endsWith("/") ? v.substring(0, v.length() - 1) : v;
    }

    private String brief(String body) {
        if (body == null) return "";
        return body.length() > 200 ? body.substring(0, 200) + "…" : body;
    }
}
