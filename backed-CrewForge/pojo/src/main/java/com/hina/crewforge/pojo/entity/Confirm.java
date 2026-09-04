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
    /** 发问节点：architect / manager 等 */
    private String node;
    /** 问题文案 */
    private String question;
    /** 选项 JSON 数组字符串（如 ["y","n"]）；null/空 = 自由文本题；第一项=超时默认答案 */
    private String optionsJson;
    /** pending / answered / auto_passed */
    private String status;
    /** 用户答案（auto_passed 时=默认选项） */
    private String reply;
    /** 超时自动放行时刻（建单时按 sys_settings.confirm_timeout_min 算好；null=永不超时） */
    private LocalDateTime expireAt;
    private LocalDateTime createTime;
    /** 人答/自动放行的时刻 */
    private LocalDateTime answerTime;

    public static final String STATUS_PENDING = "pending";
    public static final String STATUS_ANSWERED = "answered";
    public static final String STATUS_AUTO_PASSED = "auto_passed";
}
