package com.hina.crewforge.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.hina.crewforge.common.exception.BaseException;
import com.hina.crewforge.mapper.ConfirmMapper;
import com.hina.crewforge.mapper.PermissionRuleMapper;
import com.hina.crewforge.pojo.entity.Confirm;
import com.hina.crewforge.pojo.entity.PermissionRule;
import com.hina.crewforge.service.PermissionRuleService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * 命令执行权限判定（9/18）
 *
 * 这一层是**纯判定**：给定项目 + 工具 + 命令原文，返回 allow / deny / ask。
 * 它不跑命令、不弹窗、不写库（除了"记住"这一件事）；弹窗与执行在发起方（引擎 / testAgent）。
 * 这样切的原因：判定必须能被单测与复算，而"弹窗"和"执行"是它的两个不同消费者。
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class PermissionRuleServiceImpl implements PermissionRuleService {

    private final PermissionRuleMapper ruleMapper;
    private final ConfirmMapper confirmMapper;
    /** 读 confirm_mode 用（模式是判定的一部分：同一条命令在全自动/混合/手动下结论不同） */
    private final com.hina.crewforge.mapper.ProjectMapper projectMapper;

    /** 分层优先级：policy 最高，session 最低。命中的第一条就定案。 */
    private static final List<String> SOURCE_ORDER = List.of(
            PermissionRule.SOURCE_POLICY,
            PermissionRule.SOURCE_PROJECT,
            PermissionRule.SOURCE_USER,
            PermissionRule.SOURCE_SESSION);

    /**
     * 危险的 allow 规则前缀（照 Claude Code 的 dangerousPatterns）。
     *
     * 为什么必须有这一条：一条 `Bash(python:*)` 的"始终允许"看着很具体，
     * 实际效果是**把任意代码执行永久放开** —— 之后 `python -c "..."` 里写什么都算命中。
     * 所以这不是"这条规则有点宽"，是"这条规则等于没有闸门"。
     *
     * 处理方式是**剥离**（剥离后降级为 ask），而不是拒绝加载：
     * 拒绝加载会让人看到"我明明允许了却还被问"，剥离则会明说原因。
     */
    private static final List<String> DANGEROUS_ALLOW_PREFIXES = List.of(
            // 解释器：任何一条都等于放开任意代码
            "python", "python3", "python2", "node", "deno", "tsx", "ts-node",
            "ruby", "perl", "php", "lua", "osascript", "powershell", "pwsh",
            // 包运行器：`npm run <任意脚本>` / `npx <任意包>`
            "npx", "bunx", "npm run", "yarn run", "pnpm run", "bun run", "npm exec", "yarn exec",
            // shell 与远程执行
            "bash", "sh", "zsh", "fish", "ssh", "eval", "exec", "env", "xargs", "sudo",
            // 下载即执行的两条腿
            "curl", "wget", "iwr", "Invoke-WebRequest");

    @Override
    public List<PermissionRule> listVisible(Long projectId) {
        return ruleMapper.selectList(new LambdaQueryWrapper<PermissionRule>()
                .in(PermissionRule::getProjectId, globalAnd(projectId))
                .orderByAsc(PermissionRule::getProjectId)
                .orderByAsc(PermissionRule::getSource)
                .orderByAsc(PermissionRule::getId));
    }

    @Override
    public PermissionRule upsert(PermissionRule rule) {
        if (rule.getProjectId() == null) rule.setProjectId(PermissionRule.GLOBAL_PROJECT);
        if (rule.getToolName() == null || rule.getToolName().isBlank()) rule.setToolName("bash");
        if (rule.getRuleContent() == null) rule.setRuleContent("");
        if (rule.getBehavior() == null) rule.setBehavior(PermissionRule.BEHAVIOR_ASK);
        if (rule.getSource() == null) rule.setSource(PermissionRule.SOURCE_USER);
        if (rule.getEnabled() == null) rule.setEnabled(1);

        // ---------- 写入校验（9/18）：把"宽规则盖住窄规则"挡在**入库之前** ----------
        // 为什么在这里挡、而不是事后检测提示：
        //   事后检测只能告诉你"这条永远不会生效"，问题照样存在、还得你自己去删；
        //   写入时挡掉则遮蔽**根本不会产生**。防住永远比解释已经坏了的东西便宜。
        if (PermissionRule.BEHAVIOR_ALLOW.equals(rule.getBehavior()) && rule.getEnabled() == 1) {
            if (isDangerousAllow(rule.getRuleContent())) {
                throw new BaseException("这条 allow 太宽（`" + rule.getRuleContent()
                        + "`）：它的前缀是解释器 / shell / 包运行器 / 下载器，等价于放开任意代码执行。"
                        + "请收窄到具体命令，例如 `python manage.py:*` 而不是 `python:*`。");
            }
            PermissionRule shadowed = findShadowedDeny(rule);
            if (shadowed != null) {
                throw new BaseException("这条 allow 会盖住既有的 deny 规则 `" + shadowed.getRuleContent()
                        + "`（" + shadowed.getSource() + " 层）：判定按来源优先级取首个命中，"
                        + "而这条 allow 的优先级不低于它、模式又能匹配它 —— 那条 deny 将永久失效。"
                        + "请把 allow 收窄到具体命令（例如 `git status:*` 而不是 `git:*`）。");
            }
        }

        PermissionRule exist = ruleMapper.selectOne(new LambdaQueryWrapper<PermissionRule>()
                .eq(PermissionRule::getProjectId, rule.getProjectId())
                .eq(PermissionRule::getToolName, rule.getToolName())
                .eq(PermissionRule::getRuleContent, rule.getRuleContent())
                .eq(PermissionRule::getSource, rule.getSource())
                .last("LIMIT 1"));
        if (exist != null) {
            // 撞唯一键=人第二次点"始终允许"（或把 allow 改成 deny）→ 改行为，不报错
            exist.setBehavior(rule.getBehavior());
            exist.setEnabled(rule.getEnabled());
            if (rule.getNote() != null) exist.setNote(rule.getNote());
            ruleMapper.updateById(exist);
            log.info("[perm] 规则已更新 #{} {} ({}) → {}", exist.getId(), exist.getToolName(),
                    exist.getRuleContent(), exist.getBehavior());
            return exist;
        }
        ruleMapper.insert(rule);
        log.info("[perm] 规则已写入 #{} {} ({}) → {} @{}", rule.getId(), rule.getToolName(),
                rule.getRuleContent(), rule.getBehavior(), rule.getSource());
        return rule;
    }

    /**
     * 这条 allow 会不会让某条既有 deny 永久失效？
     *
     * 判据两条同时成立才算：
     *   ① **优先级不低于**：allow 的来源优先级 &lt;= deny 的（数越小越优先）。
     *      若 allow 优先级更低，它排在 deny 后面，永远轮不到它命中 —— 不构成遮蔽。
     *      等于的情况也拦：同层内按 id 先后，顺序是"碰运气"，靠运气生效的 deny 不算 deny。
     *   ② **模式能匹配**：用判定用的同一套匹配函数，拿 allow 的模式去匹配 deny 的**模式串**。
     *      `git:*` 能匹配 `git push:*` → 那条 deny 想拦的命令，allow 会先命中并放行。
     *
     * 为什么用"匹配模式串"当判据：判定跑的是一条条**具体命令**，而规则描述的是命令集合。
     * 要判断"集合 A 是否吃掉了集合 B"，在只支持前缀/通配的这套语法里，
     * "A 的模式能否匹配 B 的模式串"就是可判定且不误报的近似 —— 它只会漏（保守），不会错杀。
     */
    private PermissionRule findShadowedDeny(PermissionRule allow) {
        List<PermissionRule> denies = ruleMapper.selectList(new LambdaQueryWrapper<PermissionRule>()
                .in(PermissionRule::getProjectId, globalAnd(allow.getProjectId()))
                .eq(PermissionRule::getEnabled, 1)
                .eq(PermissionRule::getToolName, allow.getToolName())
                .eq(PermissionRule::getBehavior, PermissionRule.BEHAVIOR_DENY));
        for (PermissionRule d : denies) {
            // 整工具级 deny（无内容）不参与：那种遮蔽关系是"整工具禁掉"，属于另一种事，
            // 而且它优先级一高就该把整个工具禁掉，不该被"有条更宽的 allow"解释成遮蔽。
            if (d.getRuleContent() == null || d.getRuleContent().isBlank()) continue;
            if (d.getRuleContent().equals(allow.getRuleContent())) continue;   // 同一条（更新场景）
            if (rank(allow.getSource()) > rank(d.getSource())) continue;       // ① 优先级更低 → 遮不住
            if (matches(allow.getRuleContent(), d.getRuleContent().trim())) return d;  // ② 模式覆盖
        }
        return null;
    }

    @Override
    public void disable(Long id) {
        PermissionRule rule = ruleMapper.selectById(id);
        if (rule == null) return;
        rule.setEnabled(0);
        ruleMapper.updateById(rule);
        log.info("[perm] 规则已停用 #{} {} ({})", id, rule.getToolName(), rule.getRuleContent());
    }

    @Override
    public PermissionRule rememberAllow(Long projectId, String toolName, String ruleContent, String note) {
        PermissionRule rule = new PermissionRule();
        rule.setProjectId(projectId == null ? PermissionRule.GLOBAL_PROJECT : projectId);
        rule.setToolName(toolName == null || toolName.isBlank() ? "bash" : toolName);
        rule.setRuleContent(ruleContent == null ? "" : ruleContent.trim());
        rule.setBehavior(PermissionRule.BEHAVIOR_ALLOW);
        // 来源用 project：默认"跟着项目走"。要跨项目生效由人显式改成全局（前端有那个选项）。
        rule.setSource(PermissionRule.SOURCE_PROJECT);
        rule.setNote(note);
        return upsert(rule);
    }

    @Override
    public Map<String, Object> decide(Long projectId, String toolName, String content) {
        String tool = (toolName == null || toolName.isBlank()) ? "bash" : toolName;
        String cmd = normalize(content);

        // ⓪ 模式分流（9/18）——模式**由后端自己读**，不让调用方传：
        //    传参就会两端不一致（引擎以为自己在手动、库里是混合），而这类不一致的后果是
        //    "该拦的没拦"，且没有任何报错会提醒你。真相只有一处：sys_project.confirm_mode。
        int mode = confirmModeOf(projectId);
        if (mode == 0) {
            // 全自动 = 全部放开（用户拍板：连破坏性命令也不拦），且预算不设限。
            // 这是 Claude Code 的 bypassPermissions 那档；它保留急停开关与全量审计，
            // 我们也一样：审计在 sys_confirm/sys_permission_rule 里留痕，模式可随时切回。
            return verdict(PermissionRule.BEHAVIOR_ALLOW,
                    "全自动模式：命令一律放行（权限闸门整体旁路）", null);
        }

        List<PermissionRule> rules = ruleMapper.selectList(new LambdaQueryWrapper<PermissionRule>()
                .in(PermissionRule::getProjectId, globalAnd(projectId))
                .eq(PermissionRule::getEnabled, 1)
                .eq(PermissionRule::getToolName, tool));

        // 按来源优先级排序，取首个命中（不是合并：覆盖语义才对得上"项目里禁了"这种表达）
        rules.sort((a, b) -> Integer.compare(rank(a.getSource()), rank(b.getSource())));

        for (PermissionRule r : rules) {
            if (!matches(r.getRuleContent(), cmd)) continue;

            // ⑤ 危险 allow 规则剥离
            if (PermissionRule.BEHAVIOR_ALLOW.equals(r.getBehavior()) && isDangerousAllow(r.getRuleContent())) {
                log.warn("[perm] 规则 #{} `{}` 被剥离：该前缀等于放开任意代码执行，降级为 ask", r.getId(), r.getRuleContent());
                return verdict(PermissionRule.BEHAVIOR_ASK,
                        "命中规则 `" + r.getRuleContent() + "`，但它以解释器/shell 开头 —— "
                                + "这类允许等于放开任意代码执行，已剥离，改为问你一次",
                        r);
            }
            return verdict(r.getBehavior(), "命中规则 `" + r.getRuleContent() + "`（来源 " + r.getSource() + "）", r);
        }

        // ⑥ 没有规则命中 → 按模式决定"问不问"
        if (mode == 2) {
            // 手动：白名单之外一律问（用户拍板语义："手动就是增加更多需要批准的"）
            return verdict(PermissionRule.BEHAVIOR_ASK,
                    isReadOnly(cmd) ? "手动模式：只读命令本可放行，但为稳妥仍请你确认" : "手动模式：白名单之外一律询问", null);
        }
        // 混合（1）：只有"有后果"的命令才打扰你；纯读与无关命令直接放行。
        // （混合模式里"需要 yes"的是**换阶段**那类关键节点，不是每条命令 —— 见 architect.ts 的 confirmNode。）
        if (isConsequential(cmd)) {
            return verdict(PermissionRule.BEHAVIOR_ASK, "混合模式：这条命令有后果（改文件 / 装依赖 / 连网 / 动数据库）", null);
        }
        return verdict(PermissionRule.BEHAVIOR_ALLOW, "混合模式：没有后果的命令，不打扰你", null);
    }

    /** 项目确认模式：0=全自动 / 1=混合 / 2=手动；读不到按 0（与引擎 getProjectConfirmMode 同口径） */
    private int confirmModeOf(Long projectId) {
        if (projectId == null) return 0;
        try {
            com.hina.crewforge.pojo.entity.Project p = projectMapper.selectById(projectId);
            return p == null || p.getConfirmMode() == null ? 0 : p.getConfirmMode();
        } catch (Exception e) {
            log.warn("[perm] 读 confirm_mode 失败（按全自动处理）: {}", e.getMessage());
            return 0;
        }
    }

    /** 纯读命令：不改任何状态（混合模式下直接放行；手动模式下仍会问，但说明写清楚） */
    private static final Pattern READ_ONLY = Pattern.compile(
            "^\\s*(ls|dir|cat|type|head|tail|wc|pwd|echo|find|grep|rg|which|where|tree|stat|file)\\b"
                    + "|^\\s*git\\s+(status|diff|log|show|branch|rev-parse|ls-files|blame)\\b");

    static boolean isReadOnly(String cmd) {
        return READ_ONLY.matcher(cmd).find();
    }

    /**
     * "有后果"的命令：混合模式下才值得打断人一次。
     * 判据是**动作类型**而不是危险程度 —— 危险的那批走 DENY（不可逆），这里拦的是"会改世界状态"。
     */
    private static final Pattern CONSEQUENTIAL = Pattern.compile(
            // ① 裸解释器跑脚本 —— 等于任意代码（自己测试逮到的洞：混合模式下 node scripts/x.js 被放行了）
            "^\\s*(node|bun|deno|tsx|python|python3|ruby|perl|php|lua|osascript|powershell|pwsh)\\s+\\S"
                    + "|^\\s*(bash|sh|zsh|fish)\\s+-c\\b"
                    // ② 写盘 / 删改
                    + "|(^|\\s)>{1,2}\\s*\\S|\\btee\\b|\\bsed\\s+-i|(^|\\s)(rm|mv|cp|del|rd|rmdir|mkdir|touch|truncate)\\s"
                    // ③ 装依赖 / 构建产物
                    + "|\\b(npm|pnpm|yarn|bun)\\s+(install|i|add|remove|uninstall|ci|update|upgrade|publish)\\b"
                    + "|\\b(pip|pip3)\\s+(install|uninstall)\\b|\\b(mvn|gradle)\\s+(install|deploy|package)\\b"
                    + "|\\b(docker|kubectl|helm)\\b"
                    // ④ 连网 / 下载
                    + "|\\b(curl|wget|ssh|scp|rsync|nc|telnet)\\b|\\bgit\\s+(push|fetch|pull|clone)\\b"
                    // ⑤ 动数据库 / 进程 / 权限
                    + "|\\b(mysql|psql|mongo|redis-cli)\\b|\\b(kill|pkill|taskkill)\\b|\\b(chmod|chown|icacls)\\b",
            Pattern.CASE_INSENSITIVE);

    static boolean isConsequential(String cmd) {
        return CONSEQUENTIAL.matcher(cmd).find();
    }

    @Override
    public List<Map<String, Object>> recentDenials(Long projectId, int limit) {
        List<Confirm> rows = confirmMapper.selectList(new LambdaQueryWrapper<Confirm>()
                .eq(Confirm::getProjectId, projectId)
                .eq(Confirm::getKind, Confirm.KIND_PERMISSION)
                .eq(Confirm::getDecision, Confirm.DECISION_DENY)
                .orderByDesc(Confirm::getId)
                .last("LIMIT " + Math.max(1, Math.min(limit, 100))));
        List<Map<String, Object>> out = new ArrayList<>();
        for (Confirm r : rows) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", r.getId());
            m.put("questionId", r.getQuestionId());
            m.put("question", r.getQuestion());
            m.put("detailJson", r.getDetailJson());
            m.put("answerTime", r.getAnswerTime());
            m.put("status", r.getStatus());
            out.add(m);
        }
        return out;
    }

    // ==================== 匹配与判定小工具 ====================

    private List<Long> globalAnd(Long projectId) {
        List<Long> ids = new ArrayList<>();
        ids.add(PermissionRule.GLOBAL_PROJECT);
        if (projectId != null && projectId != PermissionRule.GLOBAL_PROJECT) ids.add(projectId);
        return ids;
    }

    private int rank(String source) {
        int i = SOURCE_ORDER.indexOf(source);
        return i < 0 ? SOURCE_ORDER.size() : i;
    }

    /** 命令归一：折叠空白、去首尾。匹配基于归一后的串，避免"多个空格就不命中"这种幻刺。 */
    private String normalize(String s) {
        return s == null ? "" : s.trim().replaceAll("\\s+", " ");
    }

    /**
     * 规则内容 ↔ 命令的匹配。四种形态（与 Claude Code 的 Bash(...) 语法一致）：
     *   ""        裸规则：整个工具（bash 的全部命令）
     *   "*"       同上，显式写法
     *   "X:*"     前缀匹配（`npm run test:*` 命中 `npm run test -- --watch`）
     *   "X"       精确匹配（归一后全等）
     * 另有 "X*" / "*X" 两种通配写法，按前缀/后缀处理。
     */
    static boolean matches(String ruleContent, String cmd) {
        if (ruleContent == null) return false;
        String r = ruleContent.trim();
        if (r.isEmpty() || "*".equals(r)) return true;
        if (r.endsWith(":*")) {
            String prefix = r.substring(0, r.length() - 2).trim();
            // 前缀必须落在"词边界"上，否则 `npm` 会命 `npmrc` 那种东西
            return cmd.equals(prefix) || cmd.startsWith(prefix + " ");
        }
        if (r.endsWith("*")) return cmd.startsWith(r.substring(0, r.length() - 1).trim());
        if (r.startsWith("*")) return cmd.endsWith(r.substring(1).trim());
        return cmd.equals(r);
    }

    /**
     * 这条 allow 规则是不是"等于没有闸门"（前缀是裸解释器 / shell / 包运行器 / 下载器）
     *
     * ⚠️ 匹配必须是**精确形状**，不是前缀包含 —— 这里踩过一次：
     *    写成 `head.startsWith(bad + " ")` 之后，`npm run test:*` 被 `npm run` 吞掉、当成危险规则剥离，
     *    于是人点了"始终允许"却发现同类命令还是问（看起来像"这功能坏了"）。
     *    区分很清楚：
     *      `npm run:*`        → 任意脚本 → 等于任意代码执行 → 剥离
     *      `npm run test:*`   → 只跑 test 这一个脚本 → 范围已收窄 → 不剥离
     *    （Claude Code 的 dangerousPatterns 同样按精确形状匹配，其源码注释写明
     *      "the matcher is exact-shape, not prefix … same reason 'npm run' is separate from 'npm'"。）
     *
     * 额外补一条它没有的：head 后面跟**开关**而不是子命令时，仍然等于放开任意代码
     *   （`bash -c:*`、`python -c:*`、`node -e:*` —— 开关不会收窄被执行的代码）。
     */
    static boolean isDangerousAllow(String ruleContent) {
        if (ruleContent == null) return false;
        String r = ruleContent.trim().toLowerCase(Locale.ROOT);
        // 裸 * / 空 = 整工具放行，同样危险
        if (r.isEmpty() || "*".equals(r)) return true;
        String head = r.endsWith(":*") ? r.substring(0, r.length() - 2).trim()
                : r.endsWith("*") ? r.substring(0, r.length() - 1).trim()
                : r;
        for (String bad : DANGEROUS_ALLOW_PREFIXES) {
            if (head.equals(bad)) return true;
            if (head.startsWith(bad + " ")) {
                String rest = head.substring(bad.length() + 1).trim();
                if (rest.startsWith("-")) return true;   // bash -c / python -c / node -e
            }
        }
        return false;
    }

    private Map<String, Object> verdict(String behavior, String reason, PermissionRule rule) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("behavior", behavior);
        m.put("reason", reason);
        m.put("ruleId", rule == null ? null : rule.getId());
        m.put("ruleContent", rule == null ? null : rule.getRuleContent());
        m.put("ruleSource", rule == null ? null : rule.getSource());
        return m;
    }

    /** 暴露给别处复用的判定正则（目前无外部使用者，留作一致性锚点） */
    static final Pattern WRITE_INTENT = Pattern.compile("(^|\\s)>{1,2}\\s*\\S|\\btee\\b|\\bsed\\s+-i|(^|\\s)rm\\s");
}
