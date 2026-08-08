package com.hina.crewforge.service;

import com.hina.crewforge.common.result.PageResult;
import com.hina.crewforge.pojo.QueryParam.TenantQueryParam;
import com.hina.crewforge.pojo.dto.TenantDTO;
import com.hina.crewforge.pojo.vo.TenantApplyVO;
import com.hina.crewforge.pojo.vo.TenantVO;

import java.util.List;

public interface TenantService {

    /**
     * 分页查询团队(按团队名称模糊搜索)
     */
    PageResult<TenantVO> page(TenantQueryParam tenantQueryParam);

    /** 新增团队，返回新团队 id（前端拿邀请码用） */
    Long create(TenantDTO dto);

    void update(Long id, TenantDTO dto);

    TenantVO getById(Long id);

    void deleteById(Long id);

    /**
     * 申请加入团队: 凭邀请码 → 校验(邀请码有效/未是成员/无待审核申请) → 写入申请表(status=0)
     */
    void apply(String code);

    /**
     * 同意申请: 校验人数上限 → 写入 sys_user_tenant(正式加入) → 申请状态改已同意
     */
    void approve(Long applyId);

    /**
     * 拒绝申请: 申请状态改已拒绝(用户可重新申请)
     */
    void reject(Long applyId);

    /**
     * 查看某团队的申请列表(管理员审核用, 按时间倒序)
     */
    List<TenantApplyVO> listApply(Long tenantId);
}
