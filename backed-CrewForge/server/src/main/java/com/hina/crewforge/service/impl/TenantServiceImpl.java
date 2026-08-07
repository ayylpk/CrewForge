package com.hina.crewforge.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.github.pagehelper.Page;
import com.github.pagehelper.PageHelper;
import com.hina.crewforge.common.context.BaseContext;
import com.hina.crewforge.common.exception.BaseException;
import com.hina.crewforge.common.result.PageResult;
import com.hina.crewforge.mapper.TenantApplyMapper;
import com.hina.crewforge.mapper.TenantMapper;
import com.hina.crewforge.mapper.UserTenantMapper;
import com.hina.crewforge.pojo.QueryParam.TenantQueryParam;
import com.hina.crewforge.pojo.dto.TenantDTO;
import com.hina.crewforge.pojo.entity.Tenant;
import com.hina.crewforge.pojo.entity.TenantApply;
import com.hina.crewforge.pojo.entity.UserTenant;
import com.hina.crewforge.pojo.vo.TenantApplyVO;
import com.hina.crewforge.pojo.vo.TenantVO;
import com.hina.crewforge.service.TenantService;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

@Service
public class TenantServiceImpl implements TenantService {

    @Autowired
    private TenantMapper tenantMapper;

    @Autowired
    private TenantApplyMapper tenantApplyMapper;

    @Autowired
    private UserTenantMapper userTenantMapper;

    @Override
    public PageResult<TenantVO> page(TenantQueryParam tenantQueryParam) {
        PageHelper.startPage(tenantQueryParam.getPage(), tenantQueryParam.getPageSize());

        List<Tenant> list = tenantMapper.list(tenantQueryParam);
        Page<Tenant> p = (Page<Tenant>)list;

        List<TenantVO> voList = p.getResult().stream().map(this::toVO).collect(Collectors.toList());

        return new PageResult<>(p.getTotal(), voList);
    }

    @Override
    public void create(TenantDTO dto) {
        Tenant entity = new Tenant();
        BeanUtils.copyProperties(dto, entity);
        LocalDateTime now = LocalDateTime.now();
        entity.setCreateTime(now);
        entity.setUpdateTime(now);
        entity.setOwnerId(BaseContext.getCurrentUserId());
        entity.setMaxMembers(Tenant.DEFAULT_MAX_MEMBERS);
        // 生成 20 位邀请码(UUID 截取), 万一撞了唯一索引就让用户重试
        entity.setInvitationCode(UUID.randomUUID().toString().replace("-", "").substring(0, 20));
        tenantMapper.insert(entity);
    }

    @Override
    public void update(Long id, TenantDTO dto) {
        Tenant entity = new Tenant();
        BeanUtils.copyProperties(dto, entity);
        entity.setId(id);
        entity.setUpdateTime(LocalDateTime.now());
        tenantMapper.updateById(entity);
    }

    @Override
    public TenantVO getById(Long id) {
        Tenant entity = tenantMapper.selectById(id);
        return toVO(entity);
    }

    @Override
    public void deleteById(Long id) {
        // BaseMapper 自带: @TableLogic 自动转逻辑删除(deleted=1)
        tenantMapper.deleteById(id);
    }

    @Override
    public void apply(String code) {
        Long userId = BaseContext.getCurrentUserId();
        // 1. 邀请码要有效(能查到团队)
        Tenant tenant = tenantMapper.selectOne(new LambdaQueryWrapper<Tenant>()
                .eq(Tenant::getInvitationCode, code));
        if (tenant == null) {
            throw new BaseException("邀请码无效");
        }
        // 2. 已经在这个团队了? (成员关系 status=1)
        Long memberCount = userTenantMapper.selectCount(new LambdaQueryWrapper<UserTenant>()
                .eq(UserTenant::getUserId, userId)
                .eq(UserTenant::getTenantId, tenant.getId())
                .eq(UserTenant::getStatus, 1));
        if (memberCount != null && memberCount > 0) {
            throw new BaseException("你已经是该团队成员");
        }
        // 3. 已经有待审核的申请了? 防止重复提交
        Long applyCount = tenantApplyMapper.selectCount(new LambdaQueryWrapper<TenantApply>()
                .eq(TenantApply::getTenantId, tenant.getId())
                .eq(TenantApply::getUserId, userId)
                .eq(TenantApply::getStatus, 0));
        if (applyCount != null && applyCount > 0) {
            throw new BaseException("已有待审核的申请, 请等待管理员处理");
        }
        // 4. 写入申请表(待审核)
        TenantApply apply = new TenantApply();
        apply.setTenantId(tenant.getId());
        apply.setUserId(userId);
        apply.setInvitationCode(code);
        apply.setStatus(0);
        tenantApplyMapper.insert(apply);
    }

    @Override
    @Transactional
    public void approve(Long applyId) {
        TenantApply apply = tenantApplyMapper.selectById(applyId);
        if (apply == null || !Integer.valueOf(0).equals(apply.getStatus())) {
            throw new BaseException("申请不存在或已处理");
        }
        // 1. 校验团队人数上限(max_members 为软限制, 允许超出 MAX_MEMBERS_BUFFER 人)
        Tenant tenant = tenantMapper.selectById(apply.getTenantId());
        Long memberCount = userTenantMapper.selectCount(new LambdaQueryWrapper<UserTenant>()
                .eq(UserTenant::getTenantId, apply.getTenantId())
                .eq(UserTenant::getStatus, 1));
        int limit = tenant.getMaxMembers() + Tenant.MAX_MEMBERS_BUFFER;
        if (memberCount != null && memberCount >= limit) {
            throw new BaseException("团队人数已满(上限 " + limit + " 人)");
        }
        // 2. 防重复: 该用户已是成员则不重复加
        Long exist = userTenantMapper.selectCount(new LambdaQueryWrapper<UserTenant>()
                .eq(UserTenant::getUserId, apply.getUserId())
                .eq(UserTenant::getTenantId, apply.getTenantId())
                .eq(UserTenant::getStatus, 1));
        if (exist != null && exist > 0) {
            throw new BaseException("该用户已是团队成员");
        }
        // 3. 写入成员关系(正式加入)
        UserTenant ut = new UserTenant();
        ut.setUserId(apply.getUserId());
        ut.setTenantId(apply.getTenantId());
        ut.setStatus(1);
        userTenantMapper.insert(ut);
        // 4. 申请状态 → 已同意
        apply.setStatus(1);
        tenantApplyMapper.updateById(apply);
    }

    @Override
    public void reject(Long applyId) {
        TenantApply apply = tenantApplyMapper.selectById(applyId);
        if (apply == null || !Integer.valueOf(0).equals(apply.getStatus())) {
            throw new BaseException("申请不存在或已处理");
        }
        // 申请状态 → 已拒绝(用户可重新申请)
        apply.setStatus(2);
        tenantApplyMapper.updateById(apply);
    }

    @Override
    public List<TenantApplyVO> listApply(Long tenantId) {
        return tenantApplyMapper.selectList(new LambdaQueryWrapper<TenantApply>()
                        .eq(TenantApply::getTenantId, tenantId)
                        .orderByDesc(TenantApply::getCreateTime))
                .stream().map(this::toApplyVO).collect(Collectors.toList());
    }

    private TenantApplyVO toApplyVO(TenantApply apply) {
        TenantApplyVO vo = new TenantApplyVO();
        BeanUtils.copyProperties(apply, vo);
        return vo;
    }

    private TenantVO toVO(Tenant tenant) {
        TenantVO vo = new TenantVO();
        BeanUtils.copyProperties(tenant, vo);
        return vo;
    }
}
