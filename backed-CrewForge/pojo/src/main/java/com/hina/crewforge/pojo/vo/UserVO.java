package com.hina.crewforge.pojo.vo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.LocalDateTime;
import java.util.List;

/**
 * 用户返回体（列表/详情用）
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class UserVO {
    private Long id;
    private String username;
    private String realName;
    private String email;
    private String phone;
    private Integer status;
    private LocalDateTime createTime;

    /** 所属团队 ID 列表（多对多） */
    private List<Long> teamIds;

    /** 所属团队名称列表（展示用） */
    private List<String> teamNames;
}
