package com.hina.crewforge.service;

import com.hina.crewforge.pojo.dto.AskConfirmDTO;
import com.hina.crewforge.pojo.entity.Confirm;

import java.util.List;
import java.util.Map;

/**
 * 确认门服务（sys_confirm）—— 阶段 3：引擎挂起问答经 HTTP+库中转，Web 答复后续跑
 */
public interface ConfirmService {

    /** 引擎建题（幂等：questionId 撞键返回既有现状）→ {status, reply} */
    Map<String, Object> ask(AskConfirmDTO dto);

    /** 引擎轮询取答案：pending=还没人答；answered/auto_passed=带 reply 终局（过期判定在这 lazy 触发） */
    Map<String, Object> getAnswer(String questionId);

    /** Web：项目当前待答问题（含题面/选项，前端弹卡数据源） */
    List<Confirm> listPending(Long projectId);

    /** Web：人提交答案（pending→answered；已答/已放行则报错） */
    void answer(Long id, String reply);

    /** 项目是否有"未过期 pending 题"——有人在等/等人在答，对账器与看门狗据此免死（阶段 3） */
    boolean hasPendingQuestion(Long projectId);

    /** 把项目过期未决的 pending 题批量判 auto_passed（引擎棒死了没人 lazy 判定时的兜底清扫），返回处理条数 */
    int sweepExpired(Long projectId);
}
