package com.hina.crewforge.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.hina.crewforge.common.exception.BaseException;
import com.hina.crewforge.mapper.ProjectMapper;
import com.hina.crewforge.mapper.ProjectRunMapper;
import com.hina.crewforge.mapper.TaskMapper;
import com.hina.crewforge.pojo.entity.Project;
import com.hina.crewforge.pojo.entity.ProjectRun;
import com.hina.crewforge.pojo.entity.Task;
import com.hina.crewforge.service.ProjectRunService;
import com.hina.crewforge.service.support.ProjectGuard;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.io.File;
import java.io.IOException;
import java.time.LocalDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 项目进程管理（沙箱：Java spawn bun 引擎）—— 阶段 2 补牢版
 *
 * 与旧实现的三处本质差异（对应施工卡 2-1）：
 *   1. 进程落库：sys_project_run 一项目一活账（B4），Java 重启不再失忆——
 *      内存 Map 只作本实例句柄，判活走 Map→DB pid(ProcessHandle) 两级；
 *   2. 按阶段起进程（9/2 拍板）：引擎收 EXIT_AT_PHASE_BOUNDARY=1，阶段收口即退出，
 *      本类的对账器发现 executing 无活进程就续拉（引擎侧按 sys_task 断点续跑）；
 *   3. 无进展熔断：每次续拉 restart_count+1，任何 sys_task 行更新过即清零；
 *      连续 {@value #MAX_NO_PROGRESS_RESTARTS} 次无进展 → 项目置 failed 停止续拉（防死循环烧钱）。
 *
 * 引擎日志写 {runs-root}/logs/p{id}.run.log —— 刻意放在 p{id} 目录外：
 * 全新开工时引擎把旧产物树 rename 进 _archive（F15 清场），目录里有开着的日志句柄 Windows 会拒绝改名。
 */
@Service
@Slf4j
@RequiredArgsConstructor
public class ProjectRunServiceImpl implements ProjectRunService {

    /** 连续无进展续拉上限（熔断）——同 §0 熔断规则的"反复出错→停手"精神 */
    private static final int MAX_NO_PROGRESS_RESTARTS = 5;

    /** 本实例活进程句柄（跨实例判活不靠它，靠 DB pid + ProcessHandle） */
    private final Map<Long, Process> processes = new ConcurrentHashMap<>();

    private final ProjectGuard projectGuard;
    private final ProjectMapper projectMapper;
    private final ProjectRunMapper projectRunMapper;
    private final TaskMapper taskMapper;

    @Value("${project-run.bun-path:bun}")
    private String bunPath;

    /** 引擎进程工作目录（bun 在这找 projectRunner.ts/node_modules/.env） */
    @Value("${project-run.engine-dir:}")
    private String engineDir;

    /** 产物树根（注入给引擎 RUNS_ROOT，A12 显式化；日志也在它下面 logs/） */
    @Value("${project-run.runs-root:}")
    private String runsRoot;

    @Value("${project-run.timeout-minutes:120}")
    private long timeoutMinutes;

    /** 按阶段起进程开关（关掉=单进程跑完全部阶段的旧行为，供手工排障） */
    @Value("${project-run.per-phase-exit:true}")
    private boolean perPhaseExit;

    // ==================== 对外三端点 ====================

    @Override
    public void start(Long projectId) {
        // B3：三端点全过所有权门（阶段 1 埋的 ProjectGuard 在此复用）
        Project project = projectGuard.requireOwned(projectId);
        assertSpawnable(project);
        if (isRunning(projectId)) {
            throw new BaseException("项目 " + projectId + " 已在运行");
        }
        Process p = spawnEngine(projectId);
        try {
            // 开工建档/重置账目：restart_count 清零、本轮起点刷新（对账器据此判进展窗）
            LocalDateTime now = LocalDateTime.now();
            ProjectRun row = projectRunMapper.selectById(projectId);
            if (row == null) {
                row = new ProjectRun();
                row.setProjectId(projectId);
            }
            row.setPid(p.pid());
            row.setRunState(ProjectRun.STATE_RUNNING);
            row.setStartedAt(now);
            row.setLastSpawnAt(now);
            row.setRestartCount(0);
            row.setExitCode(null);
            if (projectRunMapper.selectById(projectId) == null) {
                projectRunMapper.insert(row);
            } else {
                projectRunMapper.updateById(row);
            }
            // 先立"该有活进程"的牌：引擎首阶段拆分后才写 executing，中间窗口的对账靠这行
            patchStatus(projectId, "executing");
        } catch (RuntimeException e) {
            p.destroyForcibly();
            throw e;
        }
        log.info("项目 {} 开工：引擎 pid={}", projectId, p.pid());
    }

    @Override
    public Map<String, Object> status(Long projectId) {
        projectGuard.requireOwned(projectId);
        ProjectRun row = projectRunMapper.selectById(projectId);
        boolean alive = isRunning(projectId);
        // Map.of 不收 null（旧实现未运行时直接 500），换 HashMap
        Map<String, Object> res = new HashMap<>();
        res.put("running", alive);
        res.put("pid", alive ? currentPid(projectId, row) : null);
        res.put("startedAt", row == null ? null : row.getStartedAt());
        res.put("lastSpawnAt", row == null ? null : row.getLastSpawnAt());
        res.put("restartCount", row == null || row.getRestartCount() == null ? 0 : row.getRestartCount());
        res.put("runState", row == null ? null : row.getRunState());
        res.put("exitCode", row == null ? null : row.getExitCode());
        return res;
    }

    @Override
    public void stop(Long projectId) {
        Project project = projectGuard.requireOwned(projectId);
        ProjectRun row = projectRunMapper.selectById(projectId);
        Process p = processes.remove(projectId);
        if (p != null && p.isAlive()) {
            p.destroyForcibly();
        } else if (row != null && row.getPid() != null) {
            // 孤儿停止：本实例没句柄（Java 重启过）→ ProcessHandle 按 pid 杀
            ProcessHandle.of(row.getPid()).ifPresent(ProcessHandle::destroyForcibly);
        }
        if (row != null) {
            row.setRunState(ProjectRun.STATE_STOPPED);
            projectRunMapper.updateById(row);
        }
        if ("executing".equals(project.getStatus())) {
            patchStatus(projectId, "paused");
        }
        log.info("项目 {} 已停止", projectId);
    }

    // ==================== 对账器（阶段 2 心脏） ====================

    /**
     * 每 30s 对账：executing 的项目必须有活进程，没有就续拉（或熔断）。
     * 覆盖四种现场：阶段边界正常退出（等续棒）/ 崩溃被杀 / 超时看门狗杀 / Java 重启变孤儿后退出。
     */
    @Scheduled(fixedDelay = 30_000, initialDelay = 15_000)
    public void reconcile() {
        List<Project> executing;
        try {
            executing = projectMapper.selectList(
                    new LambdaQueryWrapper<Project>().eq(Project::getStatus, "executing"));
        } catch (Exception e) {
            log.warn("[run-reconcile] 扫库失败（DB 未就绪？）: {}", e.getMessage());
            return;
        }
        for (Project project : executing) {
            try {
                reconcileOne(project);
            } catch (Exception e) {
                // 一个项目对账炸不影响其余（对账器本身不许死）
                log.error("[run-reconcile] 项目 {} 对账异常: {}", project.getId(), e.getMessage(), e);
            }
        }
    }

    private void reconcileOne(Project project) {
        Long projectId = project.getId();
        Process p = processes.get(projectId);
        if (p != null && p.isAlive()) {
            return;   // 本实例在跑，最顺路的一支
        }
        ProjectRun row = projectRunMapper.selectById(projectId);
        if (row == null) {
            return;   // executing 但无账 = 手工终端跑的引擎自己置的位，不归 Java 管，不越权双起
        }
        if (!ProjectRun.STATE_RUNNING.equals(row.getRunState())) {
            return;   // 用户停过（stopped）：等人工点开工续，绝不自动拉
        }
        if (p == null && row.getPid() != null
                && ProcessHandle.of(row.getPid()).map(ProcessHandle::isAlive).orElse(false)) {
            return;   // Java 重启后孤儿仍在跑：等它本阶段自然收口，下一轮对账再接棒（不中断在途产物）
        }
        if (p != null) {
            processes.remove(projectId);
            try {
                row.setExitCode(p.exitValue());
            } catch (Exception ignored) { /* 极少见：取不到退出码不拦续拉 */ }
        }
        // 无进展熔断窗：上次拉起之后有任务行动过 = 有进展，计数清零
        if (hasTaskProgressSince(projectId, row.getLastSpawnAt())) {
            row.setRestartCount(0);
        } else {
            row.setRestartCount((row.getRestartCount() == null ? 0 : row.getRestartCount()) + 1);
        }
        if (row.getRestartCount() >= MAX_NO_PROGRESS_RESTARTS) {
            row.setRunState(ProjectRun.STATE_STOPPED);
            projectRunMapper.updateById(row);
            patchStatus(projectId, "failed");
            log.error("[run-reconcile] 项目 {} 连续 {} 次续拉无进展（exit={}），熔断置 failed——查 {}",
                    projectId, row.getRestartCount(), row.getExitCode(), logPath(projectId));
            return;
        }
        row.setRunState(ProjectRun.STATE_RUNNING);
        projectRunMapper.updateById(row);
        log.info("[run-reconcile] 项目 {} 无活进程（上棒 exit={}），续拉第 {} 次",
                projectId, row.getExitCode(), row.getRestartCount());
        spawnEngine(projectId);
    }

    /** 上次拉起之后是否有任何任务行被更新（引擎每步推进都会碰 sys_task） */
    private boolean hasTaskProgressSince(Long projectId, LocalDateTime since) {
        if (since == null) {
            return false;
        }
        Long moved = taskMapper.selectCount(new QueryWrapper<Task>()
                .eq("project_id", projectId)
                .gt("update_time", since));
        return moved != null && moved > 0;
    }

    // ==================== 进程原语 ====================

    /** 可拉性检查：手动模式等阶段 3、配置残缺直接拒，别拉个必死的进程烧对账额度 */
    private void assertSpawnable(Project project) {
        if (Project.CONFIRM_MODE_MANUAL.equals(project.getConfirmMode())) {
            throw new BaseException("手动确认模式的 Web 确认门待阶段 3 落地，暂切全绿灯/混合后再开工");
        }
        if (engineDir == null || engineDir.isBlank() || runsRoot == null || runsRoot.isBlank()) {
            throw new BaseException("project-run.engine-dir / runs-root 未配置（application.yml）");
        }
        if (!new File(engineDir, "projectRunner.ts").isFile()) {
            throw new BaseException("engine-dir 下找不到 projectRunner.ts: " + engineDir);
        }
    }

    /** 拉起引擎进程（start 与对账续拉共用），账目字段由调用方管 */
    private Process spawnEngine(Long projectId) {
        try {
            // 日志树与产物树分开：logs/p{id}.run.log（p{id} 会被引擎全新开工归档改名）
            File logDir = new File(runsRoot, "logs");
            logDir.mkdirs();
            ProcessBuilder pb = new ProcessBuilder(bunPath, "run", "projectRunner.ts", String.valueOf(projectId));
            pb.directory(new File(engineDir));
            Map<String, String> env = pb.environment();
            env.put("PROJECT_ID", String.valueOf(projectId));
            env.put("RUNS_ROOT", new File(runsRoot).getAbsolutePath());           // A12：产物树根显式化，不再靠 cwd
            env.put("AUTO_CONFIRM", "1");                                          // A9：无终端子进程，0/1 模式全auto（2 已被 assertSpawnable 拒）
            if (perPhaseExit) {
                env.put("EXIT_AT_PHASE_BOUNDARY", "1");                             // 按阶段起进程（9/2 拍板）
            }
            pb.redirectOutput(new File(logDir, "p" + projectId + ".run.log"));
            pb.redirectErrorStream(true);
            Process p = pb.start();
            processes.put(projectId, p);
            // 账本跟上（对账续拉路径也要刷 pid/lastSpawnAt）
            ProjectRun row = projectRunMapper.selectById(projectId);
            if (row != null) {
                row.setPid(p.pid());
                row.setLastSpawnAt(LocalDateTime.now());
                projectRunMapper.updateById(row);
            }
            startTimeoutWatchdog(projectId, p);
            return p;
        } catch (IOException e) {
            throw new BaseException("引擎启动失败（检查 bun-path / engine-dir）: " + e.getMessage());
        }
    }

    /** 超时看门狗：单棒进程到点强杀（B5 放宽到 120min；按阶段起棒后单棒实际远小于此） */
    private void startTimeoutWatchdog(Long projectId, Process p) {
        long timeoutMs = timeoutMinutes * 60_000L;
        Thread watcher = new Thread(() -> {
            try {
                Thread.sleep(timeoutMs);
                if (p.isAlive()) {
                    log.warn("[run-timeout] 项目 {} 进程超 {}min 强杀（对账器判无进展会续棒/熔断）", projectId, timeoutMinutes);
                    p.destroyForcibly();
                }
            } catch (InterruptedException ignored) { }
        });
        watcher.setDaemon(true);
        watcher.start();
    }

    // ==================== 小工具 ====================

    /** 两级判活：本实例句柄 → DB 记录的 pid（孤儿） */
    private boolean isRunning(Long projectId) {
        Process p = processes.get(projectId);
        if (p != null && p.isAlive()) {
            return true;
        }
        ProjectRun row = projectRunMapper.selectById(projectId);
        return row != null && row.getPid() != null
                && ProcessHandle.of(row.getPid()).map(ProcessHandle::isAlive).orElse(false);
    }

    private Long currentPid(Long projectId, ProjectRun row) {
        Process p = processes.get(projectId);
        if (p != null && p.isAlive()) {
            return p.pid();
        }
        return row == null ? null : row.getPid();
    }

    /** 只更新 status 列（updateById 忽略 null 字段） */
    private void patchStatus(Long projectId, String status) {
        Project patch = new Project();
        patch.setId(projectId);
        patch.setStatus(status);
        projectMapper.updateById(patch);
    }

    private String logPath(Long projectId) {
        return new File(new File(runsRoot, "logs"), "p" + projectId + ".run.log").getPath();
    }
}
