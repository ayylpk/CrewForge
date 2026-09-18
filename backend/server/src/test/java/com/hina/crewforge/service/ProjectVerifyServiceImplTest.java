package com.hina.crewforge.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.hina.crewforge.mapper.ProjectRunMapper;
import com.hina.crewforge.mapper.TaskMapper;
import com.hina.crewforge.pojo.entity.Project;
import com.hina.crewforge.pojo.entity.ProjectRun;
import com.hina.crewforge.pojo.entity.Task;
import com.hina.crewforge.service.impl.ProjectVerifyServiceImpl;
import com.hina.crewforge.service.support.ProjectGuard;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.test.util.ReflectionTestUtils;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

/**
 * 「验收与证据」解析层的护栏测试。
 *
 * 这一层的风险全在"读文件"上，而且踩过的坑很具体：
 *   · 验收文件里是 `{cases:[…]}` **信封**，不是裸数组（loadAcceptanceFiles 读的是 .cases）
 *   · completion.json 落在 `_verify/` 里，不是产物树根（completion.ts:90）
 *   · 产物树可能整棵不存在 —— 必须降级成 notes，绝不抛异常
 * 这些都不是类型系统能挡住的，所以用真文件 + @TempDir 钉住。
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class ProjectVerifyServiceImplTest {

    private static final Long PROJECT_ID = 20L;

    @Mock private ProjectGuard projectGuard;
    @Mock private ProjectRunMapper projectRunMapper;
    @Mock private TaskMapper taskMapper;

    @TempDir Path tmp;

    private ProjectVerifyServiceImpl service;

    @BeforeEach
    void setUp() {
        when(projectGuard.requireOwned(PROJECT_ID)).thenReturn(new Project());
        service = new ProjectVerifyServiceImpl(projectGuard, projectRunMapper, taskMapper, new ObjectMapper());
        ReflectionTestUtils.setField(service, "runsRoot", tmp.toString());
    }

    private void write(String relative, String content) throws IOException {
        Path p = tmp.resolve(relative);
        Files.createDirectories(p.getParent());
        Files.writeString(p, content, StandardCharsets.UTF_8);
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> cases(Map<String, Object> out) {
        return (List<Map<String, Object>>) ((Map<String, Object>) out.get("acceptance")).get("cases");
    }

    @SuppressWarnings("unchecked")
    private List<String> notes(Map<String, Object> out) {
        return (List<String>) out.get("notes");
    }

    @Test
    @DisplayName("读全：验收判据按 {cases:[]} 信封解出，三种 kind 各自的关键字段都摊平")
    void parsesAcceptanceEnvelopeAndAllThreeKinds() throws IOException {
        write("p20/_verify/acceptance-p1.json", """
                {"cases":[
                  {"kind":"http","id":"login","display":"登录返回 token",
                   "request":{"method":"POST","path":"/api/auth/login","body":{"u":1}},
                   "expect":{"status":200}},
                  {"kind":"command","id":"build","run":"npm run build","expect":{"exitCode":0}},
                  {"kind":"testFile","id":"unit","path":"backend/src/test/x.test.ts"}
                ]}
                """);
        write("p20/_verify/run-report.md", "# 交付关\n\n3 条判据全部执行");

        ProjectRun run = new ProjectRun();
        run.setProjectId(PROJECT_ID);
        run.setExitCode(0);
        run.setRestartCount(0);
        when(projectRunMapper.selectById(PROJECT_ID)).thenReturn(run);
        when(taskMapper.selectList(any())).thenReturn(List.of());

        Map<String, Object> out = service.evidence(PROJECT_ID);
        List<Map<String, Object>> cs = cases(out);

        assertEquals(3, cs.size(), "三条判据都要解出来（信封是 {cases:[]} 不是裸数组）");
        assertEquals("http", cs.get(0).get("kind"));
        assertEquals("POST", cs.get(0).get("method"));
        assertEquals("/api/auth/login", cs.get(0).get("path"));
        assertEquals(200, cs.get(0).get("expectStatus"));
        assertEquals(Boolean.TRUE, cs.get(0).get("hasBody"));
        assertEquals("npm run build", cs.get(1).get("command"));
        assertEquals(0, cs.get(1).get("expectExitCode"));
        assertEquals("backend/src/test/x.test.ts", cs.get(2).get("testPath"));
        assertEquals("acceptance-p1.json", cs.get(0).get("from"));
        assertNotNull(out.get("runReport"), "run-report.md 要读到");
    }

    @Test
    @DisplayName("completion.json 在 _verify/ 里能读到（曾经写错成产物树根）")
    void readsCompletionFromVerifyDir() throws IOException {
        write("p20/_verify/acceptance-p1.json", "{\"cases\":[]}");
        write("p20/_verify/completion.json", """
                {"schemaVersion":"crewforge.completion/1","status":"failed",
                 "reasons":["存在 2 个 failed 任务"],
                 "taskBreakdown":{"total":8,"done":6,"failed":2,"todo":0,"doing":0},
                 "failureDetail":{"kind":"COMPILE","message":"cannot find symbol"}}
                """);
        when(taskMapper.selectList(any())).thenReturn(List.of());

        Map<String, Object> out = service.evidence(PROJECT_ID);

        assertNotNull(out.get("completion"), "completion.json 必须从 _verify/ 读到");
    }

    @Test
    @DisplayName("产物树整棵不存在 → 降级成 notes，不抛异常（项目从没开工的真实情况）")
    void missingArtifactTreeDegradesGracefully() {
        when(taskMapper.selectList(any())).thenReturn(List.of());

        Map<String, Object> out = service.evidence(PROJECT_ID);

        assertNull(out.get("runReport"));
        assertTrue(cases(out).isEmpty());
        assertTrue(notes(out).stream().anyMatch(n -> n.contains("产物树目录不存在")),
                "要说清是产物树不存在，而不是静默返回空: " + notes(out));
        assertTrue(notes(out).stream().anyMatch(n -> n.contains("从没点过「开工」")),
                "没有运行账本也要说明: " + notes(out));
    }

    @Test
    @DisplayName("有产物树但没有 _verify/ → 明确说是「没跑执行式验证」（未验证 ≠ 通过）")
    void projectDirWithoutVerifyDirExplainsWhy() throws IOException {
        write("p20/backend/pom.xml", "<project/>");
        when(taskMapper.selectList(any())).thenReturn(List.of());

        Map<String, Object> out = service.evidence(PROJECT_ID);

        assertTrue(notes(out).stream().anyMatch(n -> n.contains("没跑执行式验证")),
                "要如实说明未验证的原因: " + notes(out));
    }

    @Test
    @DisplayName("任务级证据按 sortOrder 原样带出 result/errorMsg")
    void carriesTaskEvidence() {
        Task t = new Task();
        t.setId(7L);
        t.setProjectId(PROJECT_ID);
        t.setTitle("登录接口");
        t.setStatus("failed");
        t.setLayer("backend");
        t.setRetryCount(2);
        t.setErrorMsg("cannot find symbol");
        when(taskMapper.selectList(any())).thenReturn(List.of(t));

        Map<String, Object> out = service.evidence(PROJECT_ID);

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> ev = (List<Map<String, Object>>) out.get("taskEvidence");
        assertEquals(1, ev.size());
        assertEquals("cannot find symbol", ev.get(0).get("errorMsg"));
        assertEquals(2, ev.get(0).get("retryCount"));
    }
}
