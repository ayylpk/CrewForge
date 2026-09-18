package com.hina.crewforge.pojo.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 确认门挂起问答 (sys_confirm) —— 阶段 3：引擎 HTTP 申请 → Web 弹窗 → 人回复 → 引擎续跑
 *
 * 生命周期单向：pending → answered（人答了）| auto_passed（超时无应答，放行）。
 * ⚠️ 表无 deleted 列：实体不加 @TableLogic，问答记录是审计流水，不删只盖状态。
 * ⚠️ 超时放行的"默认答案"约定：options_json 数组第一项（与 AUTO_CONFIRM 自动答 "y" 同语义，零 DDL）。
 * question_id 是引擎生成的 uuid 幂等键——引擎进程重启重问同一题不会产生重复行（任务原子铁律的问答版）。
 * 时间列交给 DB 默认值维护。
 */
@Data
@TableName("sys_confirm")
public class Confirm {

    @TableId(type = IdType.AUTO)
    private Long id;
    /** 项目 ID（关联 sys_project.id，所有权校验用） */
    private Long projectId;
    /** 引擎生成的 questionId（uuid），幂等键 */
    private String questionId;
    /** 发问节点：architect / manager / bash 等 */
    private String node;
    /**
     * 卡的类型（9/18 权限通道）：
     *   question   —— 问答卡（LLM 主动提问，人用选项/自由文本回答）
     *   permission —— 审批卡（本地命令执行审批，三按钮：允许一次 / 始终允许 / 拒绝）
     * 两种卡共用这一条通道，因为它们要的都是"引擎挂起 → 人拍板 → 引擎续跑"这同一件事。
     */
    private String kind;
    /** 问题文案 */
    private String question;
    /** 选项 JSON 数组字符串（如 ["y","n"]）；null/空 = 自由文本题；第一项=超时默认答案 */
    private String optionsJson;
    /**
     * "要执行什么"（9/18）：JSON 对象字符串。
     * 审批卡装 {tool, command, cwd, why, matchRule, preview} —— 人必须看得见自己批的是什么
     * （命令原文、命中哪条规则、为什么要问、会动到什么）。问答卡可留空。
     */
    private String detailJson;
    /** pending / answered / auto_passed */
    private String status;
    /** 用户答案（auto_passed 时=默认选项）；审批卡的裁决也写一份到这里便于人直接读 */
    private String reply;
    /** 权限卡的裁定：allow_once / allow_always / deny（问答卡留空，看 reply） */
    private String decision;
    /** 超时自动放行时刻（建单时按 sys_settings.confirm_timeout_min 算好；null=永不超时） */
    private LocalDateTime expireAt;
    private LocalDateTime createTime;
    /** 人答/自动放行的时刻 */
    private LocalDateTime answerTime;

    public static final String STATUS_PENDING = "pending";
    public static final String STATUS_ANSWERED = "answered";
    public static final String STATUS_AUTO_PASSED = "auto_passed";

    public static final String KIND_QUESTION = "question";
    public static final String KIND_PERMISSION = "permission";

    public static final String DECISION_ALLOW_ONCE = "allow_once";
    public static final String DECISION_ALLOW_ALWAYS = "allow_always";
    public static final String DECISION_DENY = "deny";
}
