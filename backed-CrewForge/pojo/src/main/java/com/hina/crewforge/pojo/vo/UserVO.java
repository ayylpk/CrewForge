package com.hina.crewforge.pojo.vo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.LocalDateTime;
import java.util.List;

/**
 * 用户返回体（列表/详情用）
 * ⚠️ 砍掉团队功能后：移除 teamIds / teamNames
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
}
