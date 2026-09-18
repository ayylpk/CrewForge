package com.hina.crewforge.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.hina.crewforge.mapper.ProjectRunMapper;
import com.hina.crewforge.mapper.TaskMapper;
import com.hina.crewforge.pojo.entity.ProjectRun;
import com.hina.crewforge.pojo.entity.Task;
import com.hina.crewforge.service.ProjectVerifyService;
import com.hina.crewforge.service.support.ProjectGuard;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * 项目验收与证据（只读）。
 *
 * 字段口径（与前端 api/verify.ts 的 TypeScript 接口逐字段对齐）：
 *   projectId / notes          —— 项目号；notes 是"缺了什么、为什么缺"的说明数组
 *   run                        —— sys_project_run 一行（进程账本：exit_code / restart_count…）
 *   taskEvidence[]             —— sys_task 逐行（result/errorMsg 是任务级实测证据）
 *   acceptance.files[]         —— _verify/acceptance-p*.json 的文件名
 *   acceptance.cases[]         —— 把所有阶段文件里的 cases 摊平（kind/http 的 method+path+expect…）
 *   runReport                  —— _verify/run-report.md 全文（交付关实测结果 + 证据链）
 *   completion                 —— completion.json 解析后的对象
 *   logTail[]                  —— logs/p{id}.run.log 末尾若干行（引擎真实 stdout）
 *
 * 安全与稳健：
 *   · 所有权：projectGuard.requireOwned（防 IDOR 读别人项目的产物树）
 *   · 路径：只拼 "p" + 数字 projectId，不接受任何用户提供的路径片段 → 无穿越面
 *   · 一切磁盘读取都 try 包住：产物树不存在/文件被删/权限不足 → 记 note，绝不 500
 *   · 体积上限：报告 200K 字符、日志 300 行、验收文件 64 个 / 用例 500 条
 */
@Service
@Slf4j
@RequiredArgsConstructor
public class ProjectVerifyServiceImpl implements ProjectVerifyService {

    /** run-report.md 最多回传字符数（正常几十 KB；截断兜底防意外巨物） */
    private static final int REPORT_MAX_CHARS = 200_000;
    /** 引擎日志末尾回传行数 */
    private static final int LOG_TAIL_LINES = 300;
    private static final int MAX_ACCEPTANCE_FILES = 64;
    private static final int MAX_CASES = 500;

    private final ProjectGuard projectGuard;
    private final ProjectRunMapper projectRunMapper;
    private final TaskMapper taskMapper;
    private final ObjectMapper objectMapper;

    /** 产物树根（与 ProjectRunServiceImpl 同源配置） */
    @Value("${project-run.runs-root:}")
    private String runsRoot;

    @Override
    public Map<String, Object> evidence(Long projectId) {
        projectGuard.requireOwned(projectId);

        Map<String, Object> out = new LinkedHashMap<>();
        List<String> notes = new ArrayList<>();
        out.put("projectId", projectId);

        // ===== 1. 进程账本（库里一定有，除非从没开工）=====
        ProjectRun row = projectRunMapper.selectById(projectId);
        Map<String, Object> run = new LinkedHashMap<>();
        if (row == null) {
            notes.add("没有运行账本（sys_project_run 无该行）：这个项目从没点过「开工」。");
        } else {
            run.put("pid", row.getPid());
            run.put("runState", row.getRunState());
            run.put("startedAt", row.getStartedAt());
            run.put("lastSpawnAt", row.getLastSpawnAt());
            run.put("restartCount", row.getRestartCount());
            run.put("exitCode", row.getExitCode());
            if (row.getRestartCount() != null && row.getRestartCount() > 0) {
                notes.add("对账器续拉过 " + row.getRestartCount()
                        + " 次（每次拉起后无任何任务进展就 +1，连续 5 次会熔断置 failed）。");
            }
        }
        out.put("run", run);

        // ===== 2. 任务级证据（库里一定有）=====
        List<Task> tasks = taskMapper.selectList(new LambdaQueryWrapper<Task>()
                .eq(Task::getProjectId, projectId)
                .orderByAsc(Task::getSortOrder));
        out.put("taskEvidence", tasks.stream().map(t -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", t.getId());
            m.put("taskIdExt", t.getTaskIdExt());
            m.put("title", t.getTitle());
            m.put("status", t.getStatus());
            m.put("layer", t.getLayer());
            m.put("assignee", t.getAssignee());
            m.put("retryCount", t.getRetryCount());
            m.put("result", t.getResult());
            m.put("errorMsg", t.getErrorMsg());
            return m;
        }).collect(Collectors.toList()));

        // ===== 3. 产物树里的交付关证据（磁盘，可能整棵不存在）=====
        Map<String, Object> acceptance = new LinkedHashMap<>();
        acceptance.put("files", List.of());
        acceptance.put("cases", List.of());
        out.put("acceptance", acceptance);
        out.put("runReport", null);
        out.put("completion", null);
        out.put("logTail", List.of());

        File projectDir = resolveProjectDir(projectId, notes);
        if (projectDir == null) {
            out.put("notes", notes);
            return out;
        }

        File verifyDir = new File(projectDir, "_verify");
        if (!verifyDir.isDirectory()) {
            notes.add("产物树里没有 _verify/ —— 说明这次交付**没跑执行式验证**"
                    + "（可能中途失败、被停止，或该技术栈无验证器）。");
        } else {
            loadAcceptance(verifyDir, acceptance, notes);
            String report = readTextCapped(new File(verifyDir, "run-report.md"), REPORT_MAX_CHARS);
            if (report == null) {
                notes.add("没有 _verify/run-report.md：交付关没产出实测报告，"
                        + "按口径这属于**未验证**（未验证 ≠ 通过）。");
            } else {
                out.put("runReport", report);
            }

            // completion.json 也落在 _verify/ 里（completion.ts:90），
            // 且**只在 status≠done 或带 failureDetail 时才写** —— 顺利交付的项目没有它是正常的
            File completion = new File(verifyDir, "completion.json");
            if (completion.isFile()) {
                try {
                    out.put("completion", objectMapper.readTree(completion));
                } catch (Exception e) {
                    notes.add("completion.json 解析失败：" + brief(e.getMessage()));
                }
            } else {
                notes.add("没有 _verify/completion.json —— 正常：它只在**非 done 或带失败详情**时落盘，"
                        + "顺利交付的项目不写。");
            }
        }

        out.put("logTail", tailLines(resolveLogFile(projectId), LOG_TAIL_LINES, notes));
        out.put("notes", notes);
        return out;
    }

    // ==================== 小工具 ====================

    /** 产物树目录；配置缺失或目录不存在都记 note 并返回 null */
    private File resolveProjectDir(Long projectId, List<String> notes) {
        if (runsRoot == null || runsRoot.isBlank()) {
            notes.add("后端未配置 project-run.runs-root，读不到产物树。");
            return null;
        }
        // 只拼 "p" + 数字 projectId：没有任何用户可控的路径片段，不存在穿越面
        File dir = new File(new File(runsRoot), "p" + projectId);
        if (!dir.isDirectory()) {
            notes.add("产物树目录不存在（" + dir.getName() + "/）：本项目还没产出过东西，"
                    + "或产物被清理过。");
            return null;
        }
        return dir;
    }

    /** 引擎 stdout：application.yml 的 runs-root/logs/p{id}.run.log（Java spawn 时写的那份） */
    private File resolveLogFile(Long projectId) {
        if (runsRoot == null || runsRoot.isBlank()) {
            return null;
        }
        return new File(new File(runsRoot, "logs"), "p" + projectId + ".run.log");
    }

    /** 读 _verify/acceptance-p*.json，把各阶段的 cases 摊平 */
    private void loadAcceptance(File verifyDir, Map<String, Object> acceptance, List<String> notes) {
        File[] files = verifyDir.listFiles((d, name) -> name.matches("^acceptance-p\\d+\\.json$"));
        if (files == null || files.length == 0) {
            notes.add("_verify/ 里没有 acceptance-p*.json：架构师没落盘可执行验收判据，"
                    + "交付关只能退回从任务字段推导。");
            return;
        }
        List<String> names = new ArrayList<>();
        List<Map<String, Object>> cases = new ArrayList<>();
        int guard = 0;
        for (File f : files) {
            if (guard++ >= MAX_ACCEPTANCE_FILES) {
                notes.add("验收文件超过 " + MAX_ACCEPTANCE_FILES + " 个，只读了前 " + MAX_ACCEPTANCE_FILES + " 个。");
                break;
            }
            names.add(f.getName());
            try {
                JsonNode root = objectMapper.readTree(f);
                JsonNode arr = root.isArray() ? root : root.path("cases");
                if (!arr.isArray()) {
                    notes.add(f.getName() + " 里没有 cases 数组。");
                    continue;
                }
                for (JsonNode c : arr) {
                    if (cases.size() >= MAX_CASES) {
                        notes.add("验收用例超过 " + MAX_CASES + " 条，已截断。");
                        break;
                    }
                    cases.add(toCase(c, f.getName()));
                }
            } catch (Exception e) {
                notes.add(f.getName() + " 解析失败：" + brief(e.getMessage()));
            }
        }
        acceptance.put("files", names);
        acceptance.put("cases", cases);
    }

    /** 一条验收判据 → 前端可渲染的扁平结构（三种 kind 各有自己的关键字段） */
    private Map<String, Object> toCase(JsonNode c, String fromFile) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("from", fromFile);
        m.put("id", text(c, "id"));
        m.put("kind", text(c, "kind"));
        m.put("display", text(c, "display"));
        String kind = text(c, "kind");
        if ("http".equals(kind)) {
            JsonNode req = c.path("request");
            m.put("method", text(req, "method"));
            m.put("path", text(req, "path"));
            m.put("expectStatus", req.isMissingNode() ? null : intOrNull(c.path("expect").path("status")));
            m.put("hasBody", req.hasNonNull("body"));
        } else if ("command".equals(kind)) {
            m.put("command", text(c, "run"));
            m.put("expectExitCode", intOrNull(c.path("expect").path("exitCode")));
        } else if ("testFile".equals(kind)) {
            m.put("testPath", text(c, "path"));
        }
        return m;
    }

    private static String text(JsonNode node, String field) {
        JsonNode v = node.path(field);
        return v.isMissingNode() || v.isNull() ? null : v.asText(null);
    }

    private static Integer intOrNull(JsonNode node) {
        return node != null && node.isNumber() ? node.asInt() : null;
    }

    /** 读文本并截断；文件不存在返回 null */
    private String readTextCapped(File f, int maxChars) {
        if (f == null || !f.isFile()) {
            return null;
        }
        try {
            String s = Files.readString(f.toPath(), StandardCharsets.UTF_8);
            return s.length() > maxChars ? s.substring(0, maxChars) + "\n\n…（已截断，完整内容见产物树）" : s;
        } catch (IOException e) {
            log.warn("读文件失败 {}: {}", f.getPath(), e.getMessage());
            return null;
        }
    }

    /** 日志末尾 N 行（不整读大文件：从尾部按块回扫） */
    private List<String> tailLines(File f, int maxLines, List<String> notes) {
        if (f == null || !f.isFile()) {
            notes.add("没有引擎日志（logs/" + (f == null ? "?" : f.getName()) + "）："
                    + "该项目的引擎可能不是由后端 spawn 的（手工终端跑的不写这份）。");
            return List.of();
        }
        try {
            List<String> all = Files.readAllLines(f.toPath(), StandardCharsets.UTF_8);
            int from = Math.max(0, all.size() - maxLines);
            List<String> tail = new ArrayList<>(all.subList(from, all.size()));
            if (from > 0) {
                tail.add(0, "…（前面还有 " + from + " 行，此处只显示最后 " + maxLines + " 行）");
            }
            return tail;
        } catch (IOException e) {
            notes.add("引擎日志读取失败：" + brief(e.getMessage()));
            return List.of();
        }
    }

    private static String brief(String s) {
        if (s == null) {
            return "";
        }
        return s.length() > 120 ? s.substring(0, 120) + "…" : s;
    }
}
