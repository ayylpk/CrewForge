package com.hina.crewforge.service.impl;

import com.hina.crewforge.common.exception.BaseException;
import com.hina.crewforge.service.ProjectRunService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.File;
import java.io.IOException;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@Service
public class ProjectRunServiceImpl implements ProjectRunService {

    /** 进程表：projectId → Process（内存，重启即清） */
    private final Map<Long, Process> processes = new ConcurrentHashMap<>();
    private final Map<Long, Instant> startedAt = new ConcurrentHashMap<>();

    @Value("${project-run.bun-path:bun}")
    private String bunPath;

    @Value("${project-run.runs-root:}")
    private String runsRoot;

    @Value("${project-run.timeout-minutes:30}")
    private long timeoutMinutes;

    @Override
    public void start(Long projectId) {
        if (processes.containsKey(projectId)) {
            throw new BaseException("项目 " + projectId + " 已在运行");
        }
        try {
            // 工作目录：classes 根（runEnv 的 runs/ 相对它解析）
            File workDir = new File(runsRoot);
            // 日志落盘到项目房间：runs/p{id}/run.log
            File logDir = new File(runsRoot, "runs/p" + projectId);
            logDir.mkdirs();

            ProcessBuilder pb = new ProcessBuilder(bunPath, "run", "projectRunner.ts", String.valueOf(projectId));
            pb.directory(workDir);
            pb.environment().put("PROJECT_ID", String.valueOf(projectId));
            pb.redirectOutput(new File(logDir, "run.log"));   // stdout
            pb.redirectErrorStream(true);                      // stderr 一起进日志

            Process p = pb.start();
            processes.put(projectId, p);
            startedAt.put(projectId, Instant.now());

            // 超时兜底：守护线程到点杀进程（项目正常跑完自行退出则不触发）
            long timeoutMs = timeoutMinutes * 60_000L;
            Thread watcher = new Thread(() -> {
                try {
                    Thread.sleep(timeoutMs);
                    Process alive = processes.get(projectId);
                    if (alive != null && alive.isAlive()) {
                        alive.destroy();
                        processes.remove(projectId);
                        startedAt.remove(projectId);
                    }
                } catch (InterruptedException ignored) { }
            });
            watcher.setDaemon(true);
            watcher.start();
        } catch (IOException e) {
            throw new BaseException("项目启动失败（检查 bun-path 配置）: " + e.getMessage());
        }
    }

    @Override
    public Map<String, Object> status(Long projectId) {
        Process p = processes.get(projectId);
        if (p == null) {
            return Map.of("running", false, "pid", null, "startedAt", null);
        }
        return Map.of("running", p.isAlive(), "pid", p.pid(), "startedAt", startedAt.get(projectId));
    }

    @Override
    public void stop(Long projectId) {
        Process p = processes.get(projectId);
        if (p != null && p.isAlive()) {
            p.destroy();
        }
        processes.remove(projectId);
        startedAt.remove(projectId);
    }
}
