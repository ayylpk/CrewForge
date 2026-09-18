package com.hina.crewforge.service;

import com.hina.crewforge.pojo.entity.PermissionRule;

import java.util.List;
import java.util.Map;

/**
 * 命令执行权限规则服务（sys_permission_rule）—— 9/18
 *
 * 只管一件事：**一条本地命令该不该跑**。三态 allow / deny / ask，规则分层来源。
 * 不做文件权限（那条路已经锁死在项目目录内，见 context.ts 的 isRepairPathAllowed）。
 */
public interface PermissionRuleService {

    /** 列出某项目可见的全部规则：项目级 + 全局级（含停用的，便于对照"当初为什么加"） */
    List<PermissionRule> listVisible(Long projectId);

    /** 新增/更新一条规则（撞唯一键就改行为，不报错——"始终允许"点第二次不该是个错误） */
    PermissionRule upsert(PermissionRule rule);

    /** 停用一条规则（不物理删：复发时还要靠它对照） */
    void disable(Long id);

    /** 人类点"始终允许"时的入口：写一条 allow 规则并带上来源与备注 */
    PermissionRule rememberAllow(Long projectId, String toolName, String ruleContent, String note);

    /**
     * 裁决：这条命令该 allow / deny / ask？
     *
     * 顺序（照 Claude Code 的分层）：
     *   ① 策略层 → ② 项目层 → ③ 用户层 → ④ 会话层：**首个命中为准**（不是"合并"，是覆盖）
     *   ⑤ 危险 allow 规则剥离：命中也不作数，降级为 ask
     *   ⑥ 都没命中 → ask（交给人拍板，不擅自放行）
     */
    Map<String, Object> decide(Long projectId, String toolName, String content);

    /** 最近被拒的记录（供"最近被拒"面板：让人看见闸门实际拦下了什么） */
    List<Map<String, Object>> recentDenials(Long projectId, int limit);
}
