package com.hina.crewforge.pojo.dto;

import lombok.Data;

/**
 * 确认门答复入参（POST /api/confirm/{id}/answer，浏览器→Java）
 *
 * 两种卡共用：
 *   问答卡 —— 看 answer（选项原文或自由文本）
 *   审批卡 —— 看 decision（allow_once / allow_always / deny），answer 可空
 */
@Data
public class ConfirmAnswerDTO {
    /** 用户选择/输入的答案（选择题=选项原文，自由题=文本） */
    private String answer;
    /**
     * 审批卡的裁定（9/18）：allow_once / allow_always / deny。
     *
     * ⚠️ 为什么单独一列而不复用 answer：answer 的取值空间是"人写的任何字"，
     *    而裁定必须是**可判定的枚举** —— 引擎要靠它决定放行还是拒绝。
     *    靠文本去猜（判断 answer 是不是 "y"、是否以 yes 开头）在中文、大小写、带空格、
     *    以及选项本身就写成 y/n 的场景里都会错；错的方向还是"该拒的放行了"。
     */
    private String decision;
}
