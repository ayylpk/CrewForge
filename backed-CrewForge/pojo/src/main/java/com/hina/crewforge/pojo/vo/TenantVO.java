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
    /** 团队描述 */
    private String description;
    private Integer status;
    /** 邀请码(展示给前端, 用户凭此加入团队) */
    private String invitationCode;
    /** 当前成员数(创建=1, 审批通过+1) */
    private Integer members;
    /** 容量上限(创建时设置, 超出后审批时提醒) */
    private Integer maxMembers;
    /** 团队项目数(分组 COUNT 统计) */
    private Long projectCount;
    private LocalDateTime createTime;
}
