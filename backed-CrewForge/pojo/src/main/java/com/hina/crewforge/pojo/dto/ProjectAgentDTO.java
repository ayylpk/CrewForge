package com.hina.crewforge.pojo.dto;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.math.BigDecimal;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class ProjectAgentDTO {

    private Long id;
    /** 项目ID */
    private Long projectId;
    /** 所属用户ID（必传，数据隔离用） */
    private Long userId;
    /** Agent名称 */
    private String name;
    /** 职位描述 */
    private String role;
    /** 系统提示词 */
    private String systemPrompt;
    /** 可用工具列表(JSON数组字符串) */
    private String tools;
    /** 模型 */
    private String model;
    /** 采样温度 */
    private BigDecimal temperature;
    /** 状态: 1-参与项目, 0-已移出 */
    private Integer status;
}
