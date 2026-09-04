package com.hina.crewforge.pojo.dto;

import lombok.Data;

import java.util.List;

/**
 * 确认门建题入参（POST /api/confirm/engine/ask，引擎→Java）
 *
 * questionId 幂等键：撞唯一键时不报错，返回既有行现状——引擎重启重问安全。
 * options 空/缺省 = 自由文本题；options 第一项 = 超时自动放行的默认答案（v2 约定，零 DDL）。
 */
@Data
public class AskConfirmDTO {
    private String questionId;
    private Long projectId;
    /** 发问节点名（architect/manager），仅展示与审计 */
    private String node;
    private String question;
    private List<String> options;
}
