package com.hina.crewforge.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.hina.crewforge.common.exception.BaseException;
import com.hina.crewforge.mapper.ConfirmMapper;
import com.hina.crewforge.mapper.SettingsMapper;
import com.hina.crewforge.pojo.dto.AskConfirmDTO;
import com.hina.crewforge.pojo.entity.Confirm;
import com.hina.crewforge.pojo.entity.Settings;
import com.hina.crewforge.service.ConfirmService;
import com.hina.crewforge.service.PermissionRuleService;
import com.hina.crewforge.service.support.ProjectGuard;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 确认门服务实现（sys_confirm 状态机）
 *
 *      ┌── 人答（Web answer）───────────────────────┐
 *  pending ──┴─→ answered                            │ 单向，靠条件 UPDATE ... WHERE status='pending'
 *      └── 超时放行（getAnswer 时 lazy 判定）→ auto_passed ┘   保证两路竞争只有一个赢
 *
 * 超时判定放在 getAnswer（引擎轮询时顺手触发）而不是 @Scheduled 扫描：
 * 反正引擎一直在轮询，lazy 判定零定时器、零额外状态——没人问就没有过期，天然自洽。
 */
@Service
@Slf4j
@RequiredArgsConstructor
public class ConfirmServiceImpl implements ConfirmService {

    /** confirm_timeout_min 读不到时的兜底（与 sys_settings 种子一致） */
    private static final int DEFAULT_TIMEOUT_MIN = 30;

    private final ConfirmMapper confirmMapper;
    private final SettingsMapper settingsMapper;
    private final ProjectGuard projectGuard;
    /**
     * 权限卡选"始终允许"时要写规则 —— 依赖方向是 ConfirmService → PermissionRuleService（单向）：
     * 反向依赖（规则服务去读确认门）会成环，而"谁来写规则"这件事本来就属于答复的处理。
     */
    private final PermissionRuleService permissionRuleService;
    private final ObjectMapper objectMapper;

    @Override
    public Map<String, Object> ask(AskConfirmDTO dto) {
        if (dto.getQuestionId() == null || dto.getQuestionId().isBlank()) {
            throw new BaseException("questionId 不能为空");
        }
        if (dto.getProjectId() == null || dto.getQuestion() == null || dto.getQuestion().isBlank()) {
            throw new BaseException("projectId/question 不能为空");
        }
        Confirm existing = selectByQuestionId(dto.getQuestionId());
        if (existing != null) {
            // 幂等命中：引擎重发/重启直接拿现状，不产生重复题
            return snapshot(existing);
        }
        Confirm row = new Confirm();
        row.setProjectId(dto.getProjectId());
        row.setQuestionId(dto.getQuestionId());
        row.setNode(dto.getNode() == null || dto.getNode().isBlank() ? "unknown" : dto.getNode());
        // 卡的类型（9/18）：缺省 question，老调用方一字不改
        row.setKind(Confirm.KIND_PERMISSION.equals(dto.getKind()) ? Confirm.KIND_PERMISSION : Confirm.KIND_QUESTION);
        row.setQuestion(dto.getQuestion());
        List<String> options = dto.getOptions() == null ? List.of() : dto.getOptions();
        try {
            row.setOptionsJson(options.isEmpty() ? null : objectMapper.writeValueAsString(options));
        } catch (Exception e) {
            throw new BaseException("options 序列化失败: " + e.getMessage());
        }
        // "要执行什么"原样存：审批卡的价值全在这几个键里，Java 侧不解析、不改写。
        // ruleContent 塞进 detail 里一起存 —— 它的唯一用途是"人选始终允许时要写哪条规则"，
        // 让 detail_json 自包含，前端才能把"我将写入 Bash(xxx)"显示给人看。
        try {
            Map<String, Object> detail = dto.getDetail() == null ? new LinkedHashMap<>() : new LinkedHashMap<>(dto.getDetail());
            if (dto.getRuleContent() != null && !dto.getRuleContent().isBlank()) {
                detail.put("ruleContent", dto.getRuleContent());
            }
            row.setDetailJson(detail.isEmpty() ? null : objectMapper.writeValueAsString(detail));
        } catch (Exception e) {
            throw new BaseException("detail 序列化失败: " + e.getMessage());
        }
        row.setStatus(Confirm.STATUS_PENDING);
        row.setExpireAt(LocalDateTime.now().plusMinutes(currentTimeoutMin()));
        try {
            confirmMapper.insert(row);
        } catch (DuplicateKeyException dup) {
            // 并发撞唯一键（同 questionId 双开）：谁赢都行，输家读赢家现状
            Confirm race = selectByQuestionId(dto.getQuestionId());
            if (race == null) {
                throw new BaseException("建题撞键却读不到行，请查 sys_confirm");
            }
            return snapshot(race);
        }
        log.info("[confirm] 建题 {}（项目 {} / 节点 {} / 类型 {}），{} 分钟内无人应答{}",
                row.getQuestionId(), row.getProjectId(), row.getNode(), row.getKind(), currentTimeoutMin(),
                Confirm.KIND_PERMISSION.equals(row.getKind()) ? "按【拒绝】处理（权限卡 fail-closed）" : "自动放行");
        return snapshot(row);
    }

    @Override
    public Map<String, Object> getAnswer(String questionId) {
        Confirm row = selectByQuestionId(questionId);
        if (row == null) {
            throw new BaseException("问题不存在: " + questionId);
        }
        if (Confirm.STATUS_PENDING.equals(row.getStatus())
                && row.getExpireAt() != null && LocalDateTime.now().isAfter(row.getExpireAt())) {
            passExpired(row);
            row = selectByQuestionId(questionId);   // 重读拿终局（可能人刚好抢答了 answered）
        }
        return snapshot(row);
    }

    @Override
    public List<Confirm> listPending(Long projectId) {
        projectGuard.requireOwned(projectId);
        sweepExpired(projectId);   // 过期题先放行再列卡，看板不挂"答不了的字条"
        return confirmMapper.selectList(new LambdaQueryWrapper<Confirm>()
                .eq(Confirm::getProjectId, projectId)
                .eq(Confirm::getStatus, Confirm.STATUS_PENDING)
                .orderByAsc(Confirm::getId));
    }

    @Override
    public List<Confirm> listByProject(Long projectId) {
        projectGuard.requireOwned(projectId);
        // 不过滤 status：已答/已放行都要留痕（这就是"对话记录"）。
        // 不清 sweepExpired：历史是只读的，不该有副作用。
        return confirmMapper.selectList(new LambdaQueryWrapper<Confirm>()
                .eq(Confirm::getProjectId, projectId)
                .orderByAsc(Confirm::getId));
    }

    @Override
    public void answer(Long id, String reply, String decision) {
        Confirm row = confirmMapper.selectById(id);
        if (row == null) {
            throw new BaseException("问题不存在: " + id);
        }
        projectGuard.requireOwned(row.getProjectId());   // 所有权：只能答自己项目的题

        // 审批卡：裁定必须是合法枚举。**宁可报错也不"猜"** —— 猜错的方向是"该拒的放行了"。
        boolean isPermission = Confirm.KIND_PERMISSION.equals(row.getKind());
        String dec = decision == null ? null : decision.trim();
        if (isPermission) {
            if (dec == null || dec.isBlank()) {
                throw new BaseException("权限卡必须给 decision（allow_once / allow_always / deny）");
            }
            if (!List.of(Confirm.DECISION_ALLOW_ONCE, Confirm.DECISION_ALLOW_ALWAYS, Confirm.DECISION_DENY).contains(dec)) {
                throw new BaseException("decision 非法: " + dec + "（只接受 allow_once / allow_always / deny）");
            }
        } else if (reply == null || reply.isBlank()) {
            throw new BaseException("answer 不能为空");
        }

        Confirm patch = new Confirm();
        patch.setStatus(Confirm.STATUS_ANSWERED);
        patch.setAnswerTime(LocalDateTime.now());
        if (isPermission) {
            patch.setDecision(dec);
            // reply 也写一份人可读的话：审计流水里直接看得到"批了什么"，不用再解析 decision
            patch.setReply(switch (dec) {
                case Confirm.DECISION_ALLOW_ONCE -> "允许一次";
                case Confirm.DECISION_ALLOW_ALWAYS -> "始终允许";
                default -> "拒绝";
            });
        } else {
            patch.setReply(reply.trim());
        }
        int won = confirmMapper.update(patch, new LambdaUpdateWrapper<Confirm>()
                .eq(Confirm::getId, id)
                .eq(Confirm::getStatus, Confirm.STATUS_PENDING));
        if (won == 0) {
            throw new BaseException("该问题已被回答或已自动放行，无需重复提交");
        }

        // "始终允许" → 把规则写进库，下次同类命令不再问。
        // 规则内容由**发起方**在 detail.ruleContent 里给（只有它知道这条命令该怎么泛化）；
        // 这里兜底拒绝：没有 ruleContent 就不写规则，绝不退化成"给整个工具放行"。
        if (isPermission && Confirm.DECISION_ALLOW_ALWAYS.equals(dec)) {
            String ruleContent = ruleContentOf(row);
            if (ruleContent == null || ruleContent.isBlank()) {
                log.warn("[confirm] {} 选了始终允许，但题面没带 ruleContent → 不写规则（不退化成整工具放行）",
                        row.getQuestionId());
            } else {
                try {
                    permissionRuleService.rememberAllow(row.getProjectId(), toolOf(row), ruleContent,
                            "由审批卡写入：" + row.getQuestionId());
                } catch (Exception e) {
                    log.warn("[confirm] 规则写入失败（答复已生效，不因此回滚）: {}", e.getMessage());
                }
            }
        }

        log.info("[confirm] 问题 {}（{}）已裁定 {}，引擎轮询将续跑", row.getQuestionId(), row.getKind(),
                isPermission ? dec : patch.getReply());
    }

    @Override
    public boolean hasPendingQuestion(Long projectId) {
        Long n = confirmMapper.selectCount(new LambdaQueryWrapper<Confirm>()
                .eq(Confirm::getProjectId, projectId)
                .eq(Confirm::getStatus, Confirm.STATUS_PENDING)
                .gt(Confirm::getExpireAt, LocalDateTime.now()));
        return n != null && n > 0;
    }

    @Override
    public int sweepExpired(Long projectId) {
        // 引擎棒中途死掉后没人轮询，lazy 判定失效——过期 pending 题会永远挂着看板。
        // 对账器续拉前 / Web 列卡前顺手扫一遍：过期=等同样没人理，按默认答案放行，语义不变。
        List<Confirm> expired = confirmMapper.selectList(new LambdaQueryWrapper<Confirm>()
                .eq(Confirm::getProjectId, projectId)
                .eq(Confirm::getStatus, Confirm.STATUS_PENDING)
                .isNotNull(Confirm::getExpireAt)
                .lt(Confirm::getExpireAt, LocalDateTime.now()));
        for (Confirm row : expired) {
            passExpired(row);   // 条件更新自带并发保护（与人答竞争只有一个赢）
        }
        return expired.size();
    }

    // ==================== 小工具 ====================

    /**
     * 过期未决 → auto_passed（条件更新 WHERE pending：与人答竞争只有一个赢，状态单向）
     *
     * ⚠️ 9/18 分流：**权限卡超时必须按拒绝处理（fail-closed）**。
     *    对问答卡，"超时=按默认答案放行"是合理的（不答就是没意见，别把流水线卡死）。
     *    对权限卡，"超时=当你批准了"方向是错的 —— 人不在的时候，默认应当是**不许跑**，
     *    否则一个挂机的晚上就足够让所有没人在看的破坏性命令跑完。
     *    这也和 Claude Code 的立场一致：没人应答的审批不会自己变成允许。
     */
    private void passExpired(Confirm row) {
        boolean permission = Confirm.KIND_PERMISSION.equals(row.getKind());
        Confirm patch = new Confirm();
        patch.setStatus(Confirm.STATUS_AUTO_PASSED);
        patch.setAnswerTime(LocalDateTime.now());
        if (permission) {
            patch.setDecision(Confirm.DECISION_DENY);
            patch.setReply("拒绝（超时无人应答，权限卡按拒绝处理）");
        } else {
            patch.setReply(defaultAnswer(row));
        }
        int won = confirmMapper.update(patch, new LambdaUpdateWrapper<Confirm>()
                .eq(Confirm::getId, row.getId())
                .eq(Confirm::getStatus, Confirm.STATUS_PENDING));
        if (won > 0) {
            if (permission) {
                log.info("[confirm] 审批 {} 超时无人应答 → 拒绝（fail-closed，不放行）", row.getQuestionId());
            } else {
                log.info("[confirm] 问题 {} 超时无应答 → auto_passed（默认答案「{}」放行）", row.getQuestionId(), patch.getReply());
            }
        }
    }

    /** 从 detail_json 里取发起方给的规则内容（"始终允许"要写哪条规则） */
    private String ruleContentOf(Confirm row) {
        Map<String, Object> detail = detailOf(row);
        Object rc = detail.get("ruleContent");
        return rc == null ? null : String.valueOf(rc);
    }

    /** 工具名：detail.tool 优先，退到 node（引擎建题时 node 写的就是工具名） */
    private String toolOf(Confirm row) {
        Object tool = detailOf(row).get("tool");
        if (tool != null && !String.valueOf(tool).isBlank()) return String.valueOf(tool);
        return (row.getNode() == null || row.getNode().isBlank()) ? "bash" : row.getNode();
    }

    /** detail_json → Map；坏 JSON 当空（审批卡退化成"只有题面"，也不至于炸） */
    @SuppressWarnings("unchecked")
    private Map<String, Object> detailOf(Confirm row) {
        if (row.getDetailJson() == null || row.getDetailJson().isBlank()) return Map.of();
        try {
            return objectMapper.readValue(row.getDetailJson(), Map.class);
        } catch (Exception e) {
            log.warn("[confirm] detail_json 解析失败（按空处理）: {}", e.getMessage());
            return Map.of();
        }
    }

    private Confirm selectByQuestionId(String questionId) {
        return confirmMapper.selectOne(new LambdaQueryWrapper<Confirm>()
                .eq(Confirm::getQuestionId, questionId)
                .last("LIMIT 1"));
    }

    /** 引擎/Web 共用出参：status 恒有；终局才带 reply（pending 时 reply=null 表示"还没人理"）
     *  9/18 增补 kind/decision/detail：引擎要靠 decision 判断"该不该跑这条命令"，
     *  不能靠 reply 的文本 —— 见 ConfirmAnswerDTO.decision 的注释。 */
    private Map<String, Object> snapshot(Confirm row) {
        boolean pending = Confirm.STATUS_PENDING.equals(row.getStatus());
        Map<String, Object> m = new HashMap<>();
        m.put("id", row.getId());
        m.put("questionId", row.getQuestionId());
        m.put("kind", row.getKind());
        m.put("status", row.getStatus());
        m.put("decision", pending ? null : row.getDecision());
        m.put("reply", pending ? null : row.getReply());
        m.put("detail", detailOf(row));
        m.put("expireAt", row.getExpireAt());
        return m;
    }

    /** 超时默认答案=options 第一项（v2 约定，同 AUTO_CONFIRM 答 "y"）；自由文本题无默认 → 空串 */
    private String defaultAnswer(Confirm row) {
        try {
            if (row.getOptionsJson() != null) {
                List<String> opts = objectMapper.readValue(row.getOptionsJson(), new TypeReference<>() { });
                if (!opts.isEmpty()) {
                    return opts.get(0);
                }
            }
        } catch (Exception e) {
            log.warn("[confirm] options_json 解析失败（题 {}），按无默认处理: {}", row.getId(), e.getMessage());
        }
        return "";
    }

    private int currentTimeoutMin() {
        try {
            Settings s = settingsMapper.selectById(1);
            if (s != null && s.getConfirmTimeoutMin() != null) {
                return s.getConfirmTimeoutMin();
            }
        } catch (Exception e) {
            log.warn("[confirm] 读 confirm_timeout_min 失败，用默认 {} 分钟: {}", DEFAULT_TIMEOUT_MIN, e.getMessage());
        }
        return DEFAULT_TIMEOUT_MIN;
    }
}
