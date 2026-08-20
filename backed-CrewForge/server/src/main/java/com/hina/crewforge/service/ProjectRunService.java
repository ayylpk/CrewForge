package com.hina.crewforge.service;

import java.util.Map;

/** 项目进程管理（沙箱：一项目一进程，Java 负责启停） */
public interface ProjectRunService {
    /** 启动项目（spawn bun run projectRunner.ts {projectId}） */
    void start(Long projectId);

    /** 查状态：是否运行中 / pid / 启动时间 */
    Map<String, Object> status(Long projectId);

    /** 停止项目（杀进程） */
    void stop(Long projectId);
}
