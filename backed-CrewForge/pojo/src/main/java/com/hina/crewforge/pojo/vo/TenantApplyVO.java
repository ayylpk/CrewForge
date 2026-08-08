package com.hina.crewforge.pojo.vo;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import java.time.LocalDateTime;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class TenantApplyVO {
    private Long id;
    private Long tenantId;
    private Long userId;
    /** 申请人用户名（联查 sys_user） */
    private String username;
    /** 申请人真实姓名（联查 sys_user） */
    private String realName;
    /** 填写的邀请码 */
    private String invitationCode;
    /** 状态: 0-待审核, 1-已同意, 2-已拒绝 */
    private Integer status;
    /** 申请留言 */
    private String applyMsg;
    private LocalDateTime createTime;
}
