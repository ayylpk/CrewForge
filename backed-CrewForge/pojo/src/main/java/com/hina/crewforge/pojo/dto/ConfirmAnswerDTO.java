package com.hina.crewforge.pojo.dto;

import lombok.Data;

/** 确认门答复入参（POST /api/confirm/{id}/answer，浏览器→Java） */
@Data
public class ConfirmAnswerDTO {
    /** 用户选择/输入的答案（选择题=选项原文，自由题=文本） */
    private String answer;
}
