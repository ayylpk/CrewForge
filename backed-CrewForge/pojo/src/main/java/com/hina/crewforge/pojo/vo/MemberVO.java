package com.hina.crewforge.pojo.vo;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import java.time.LocalDateTime;

/**
 * 团队成员 (sys_user_tenant join sys_user)
 * role: 管理员(owner) / 成员
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class MemberVO {
    /** 用户ID */
    private Long id;
    /** 用户名 */
    private String username;
    /** 真实姓名 */
    private String realName;
    /** 角色: 管理员 / 成员 */
    private String role;
    /** 加入时间 */
    private LocalDateTime createTime;
}
