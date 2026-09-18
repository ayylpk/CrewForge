package com.hina.crewforge.service;

import java.util.Map;

/**
 * 项目验收与证据（只读）—— 把引擎落在产物树里的交付关证据端出来。
 *
 * 背景：引擎跑完会写 {runsRoot}/p{id}/_verify/run-report.md（交付关实测结果 + 证据链）
 * 与 completion.json（终态判据的输入与理由），但 Web 侧一直没有入口 ——
 * 项目落了 done/failed/blocked，人却看不到"凭什么"。
 *
 * 该接口只读：不写库、不改产物树、不触发任何引擎动作。
 */
public interface ProjectVerifyService {

    /**
     * 读某项目的验收证据。所有权由 ProjectGuard 校验。
     *
     * @return 结构化证据包（见 ProjectVerifyServiceImpl 的字段说明）；产物树缺失时
     *         返回 DB 侧可得的部分 + notes 说明缺什么，不抛异常
     */
    Map<String, Object> evidence(Long projectId);
}
