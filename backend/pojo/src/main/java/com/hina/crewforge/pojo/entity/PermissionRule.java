package com.hina.crewforge.pojo.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 命令执行权限规则 (sys_permission_rule) —— 9/18
 *
 * 做的是"本地命令执行的安全权限"：allow / deny / ask 三态 + 分层来源。
 *
 * 为什么规则要带 source：
 *   同一条命令在"策略 &gt; 项目 &gt; 用户 &gt; 会话"四层里可能被允许也可能被拒。
 *   没有来源就没法表达"这个项目里禁掉、但别把我的其它项目也一起禁了"。
 *   判定时按优先级取**首个命中**（见 PermissionRuleService.decide）。
 *
 * 为什么危险规则不在这里判：
 *   "Bash(python:*) 这类允许规则等于放开任意代码执行"是一条**判定谓词**，不是数据。
 *   落成表就得与代码清单双向同步，清单一更新就漂移；所以它是代码（isDangerousAllow）。
 */
@Data
@TableName("sys_permission_rule")
public class PermissionRule {

    @TableId(type = IdType.AUTO)
    private Long id;
    /** 0 = 全局（跟着人走，跨项目生效）；否则 = 项目级（跟着项目走） */
    private Long projectId;
    /** 工具名，目前只有 bash */
    private String toolName;
    /** 规则内容，即 Bash(&lt;这里&gt;) 括号内的部分；空串 = 该工具的裸规则（整工具放行/拒绝） */
    private String ruleContent;
    /** allow / deny / ask */
    private String behavior;
    /** policy / project / user / session —— 判定优先级从高到低 */
    private String source;
    /** 停用后仍留档：复发时能对照"当初为什么加了这条" */
    private Integer enabled;
    /** 人类备注：谁在什么时候点了"始终允许" */
    private String note;
    private LocalDateTime createTime;
    private LocalDateTime updateTime;

    public static final String BEHAVIOR_ALLOW = "allow";
    public static final String BEHAVIOR_DENY = "deny";
    public static final String BEHAVIOR_ASK = "ask";

    public static final String SOURCE_POLICY = "policy";
    public static final String SOURCE_PROJECT = "project";
    public static final String SOURCE_USER = "user";
    public static final String SOURCE_SESSION = "session";

    /** 全局（跟着人走）在库里的 project_id —— 用 0 而不是 NULL：
     *  NULL 在唯一键里互不相等，会导致同一条全局规则能重复插入。 */
    public static final long GLOBAL_PROJECT = 0L;
}
