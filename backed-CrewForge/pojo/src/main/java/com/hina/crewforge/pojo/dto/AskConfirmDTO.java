package com.hina.crewforge.pojo.dto;

import lombok.Data;

import java.util.List;
import java.util.Map;

/**
 * 确认门建题入参（POST /api/confirm/engine/ask，引擎/testAgent→Java）
 *
 * questionId 幂等键：撞唯一键时不报错，返回既有行现状——引擎重启重问安全。
 * options 空/缺省 = 自由文本题；options 第一项 = 超时自动放行的默认答案（v2 约定，零 DDL）。
 *
 * 9/18 扩成"权限与对话共用通道"：多出 kind / detail / ruleContent 三个字段。
 * 老的澄清提问（manager/architect）不带它们，走缺省值，行为一字不变。
 */
@Data
public class AskConfirmDTO {
    private String questionId;
    private Long projectId;
    /** 发问节点名（architect/manager/bash…），仅展示与审计 */
    private String node;
    /**
     * 卡的类型：question（问答，缺省）/ permission（命令执行审批）。
     * 缺省 question 是**向后兼容**：已有调用方不带这个字段。
     */
    private String kind;
    private String question;
    private List<String> options;
    /**
     * "要执行什么"（审批卡必填、问答卡可空）：{tool, command, cwd, why, matchRule, preview}。
     *
     * 用 Map 而不是再定义一套 DTO：字段随工具而变，形状由发起方（引擎/testAgent）决定，
     * Java 侧只负责**原样存、原样回**，不解析 —— 一解析就会因为"多了一个没见过的键"而丢数据，
     * 而审批卡的全部价值就在那几个键里。
     */
    private Map<String, Object> detail;
    /**
     * 若人选"始终允许"，要写入的规则内容（如 `npm run test:*`）。
     * 由**发起方**算好：只有它知道这条命令该怎么泛化。浏览器不该猜 —— 猜错就是把一条
     * 过宽的规则（乃至 `*`）写进库，那等于自己把闸门拆了。
     */
    private String ruleContent;
}
