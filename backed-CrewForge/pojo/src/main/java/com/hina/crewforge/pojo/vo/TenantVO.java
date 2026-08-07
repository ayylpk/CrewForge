package com.hina.crewforge.pojo.vo;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import java.time.LocalDateTime;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class TenantVO {
    private Long id;
    private String name;
    /** 团队创建人/管理员ID */
    private Long ownerId;
    private String contact;
    private String phone;
    private Integer status;
    /** 邀请码(展示给前端, 用户凭此加入团队) */
    private String invitationCode;
    /** 团队人数上限 */
    private Integer maxMembers;
    private LocalDateTime createTime;
}
