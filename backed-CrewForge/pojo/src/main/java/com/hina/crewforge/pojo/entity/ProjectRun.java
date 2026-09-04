package com.hina.crewforge.pojo.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 项目运行活账 (sys_project_run) —— 阶段 2 B4：进程表不再只活在内存
 *
 * 一项目一行、project_id 即主键（账目复用不删除，所以无 deleted 逻辑删列）。
 * 用途（ProjectRunServiceImpl 的对账器 + 孤儿判活）：
 *   - Java 重启内存 Map 清空 → 靠 pid + ProcessHandle 判孤儿死活，不双起
 *   - 按阶段起进程（9/2 拍板）：引擎阶段收口就退出 → 对账器从这行续拉下一棒
 *   - 熔断：restart_count 数"无进展续拉"，任何任务 update_time 前进即清零；触顶置 failed
 * 时间列交给 DB 默认值/ON UPDATE 维护（本库无 MetaObjectHandler）。
 */
@Data
@TableName("sys_project_run")
public class ProjectRun {

    /** 运行账状态：running=在跑或等对账续拉 */
    public static final String STATE_RUNNING = "running";
    /** 运行账状态：stopped=用户停止或对账熔断（对账器不碰） */
    public static final String STATE_STOPPED = "stopped";

    /** 项目ID（主键=外键，一项目一账） */
    @TableId(type = IdType.INPUT)
    private Long projectId;
    /** 最近一次引擎进程 PID（孤儿判活/跨实例停止用 ProcessHandle） */
    private Long pid;
    /** 运行账状态: running/stopped */
    private String runState;
    /** 本轮开工时间（点"开工"刷新；进程级重启不刷） */
    private LocalDateTime startedAt;
    /** 最近一次拉起时间（无进展熔断窗的起点） */
    private LocalDateTime lastSpawnAt;
    /** 连续无进展续拉次数（有任务进展即清零；≥5=熔断置 failed） */
    private Integer restartCount;
    /** 最近一次进程退出码（阶段边界正常收口=0；对账器记录） */
    private Integer exitCode;
    private LocalDateTime updateTime;
}
