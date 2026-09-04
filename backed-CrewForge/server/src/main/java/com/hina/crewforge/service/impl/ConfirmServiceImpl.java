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
import com.hina.crewforge.service.support.ProjectGuard;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.HashMap;
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
        row.setQuestion(dto.getQuestion());
        List<String> options = dto.getOptions() == null ? List.of() : dto.getOptions();
        try {
            row.setOptionsJson(options.isEmpty() ? null : objectMapper.writeValueAsString(options));
        } catch (Exception e) {
            throw new BaseException("options 序列化失败: " + e.getMessage());
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
        log.info("[confirm] 建题 {}（项目 {} / 节点 {}），{} 分钟内无人应答自动放行",
                row.getQuestionId(), row.getProjectId(), row.getNode(), currentTimeoutMin());
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
    public void answer(Long id, String reply) {
        Confirm row = confirmMapper.selectById(id);
        if (row == null) {
            throw new BaseException("问题不存在: " + id);
        }
        projectGuard.requireOwned(row.getProjectId());   // 所有权：只能答自己项目的题
        if (reply == null || reply.isBlank()) {
            throw new BaseException("answer 不能为空");
        }
        Confirm patch = new Confirm();
        patch.setStatus(Confirm.STATUS_ANSWERED);
        patch.setReply(reply.trim());
        patch.setAnswerTime(LocalDateTime.now());
        int won = confirmMapper.update(patch, new LambdaUpdateWrapper<Confirm>()
                .eq(Confirm::getId, id)
                .eq(Confirm::getStatus, Confirm.STATUS_PENDING));
        if (won == 0) {
            throw new BaseException("该问题已被回答或已自动放行，无需重复提交");
        }
        log.info("[confirm] 问题 {} 已答复「{}」，引擎轮询将续跑", row.getQuestionId(), patch.getReply());
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

    /** 过期未决 → auto_passed（条件更新 WHERE pending：与人答竞争只有一个赢，状态单向） */
    private void passExpired(Confirm row) {
        Confirm patch = new Confirm();
        patch.setStatus(Confirm.STATUS_AUTO_PASSED);
        patch.setReply(defaultAnswer(row));
        patch.setAnswerTime(LocalDateTime.now());
        int won = confirmMapper.update(patch, new LambdaUpdateWrapper<Confirm>()
                .eq(Confirm::getId, row.getId())
                .eq(Confirm::getStatus, Confirm.STATUS_PENDING));
        if (won > 0) {
            log.info("[confirm] 问题 {} 超时无应答 → auto_passed（默认答案「{}」放行）", row.getQuestionId(), patch.getReply());
        }
    }

    private Confirm selectByQuestionId(String questionId) {
        return confirmMapper.selectOne(new LambdaQueryWrapper<Confirm>()
                .eq(Confirm::getQuestionId, questionId)
                .last("LIMIT 1"));
    }

    /** 引擎/Web 共用出参：status 恒有；终局才带 reply（pending 时 reply=null 表示"还没人理"） */
    private Map<String, Object> snapshot(Confirm row) {
        Map<String, Object> m = new HashMap<>();
        m.put("id", row.getId());
        m.put("questionId", row.getQuestionId());
        m.put("status", row.getStatus());
        m.put("reply", Confirm.STATUS_PENDING.equals(row.getStatus()) ? null : row.getReply());
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
