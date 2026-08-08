package com.hina.crewforge.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.github.pagehelper.Page;
import com.github.pagehelper.PageHelper;
import com.hina.crewforge.common.context.BaseContext;
import com.hina.crewforge.common.exception.BaseException;
import com.hina.crewforge.common.result.PageResult;
import com.hina.crewforge.mapper.ProjectMapper;
import com.hina.crewforge.mapper.TenantApplyMapper;
import com.hina.crewforge.mapper.TenantMapper;
import com.hina.crewforge.mapper.UserMapper;
import com.hina.crewforge.mapper.UserTenantMapper;
import com.hina.crewforge.pojo.QueryParam.TenantQueryParam;
import com.hina.crewforge.pojo.dto.TenantDTO;
import com.hina.crewforge.pojo.entity.Project;
import com.hina.crewforge.pojo.entity.Tenant;
import com.hina.crewforge.pojo.entity.TenantApply;
import com.hina.crewforge.pojo.entity.User;
import com.hina.crewforge.pojo.entity.UserTenant;
import com.hina.crewforge.pojo.vo.TenantApplyVO;
import com.hina.crewforge.pojo.vo.TenantVO;
import com.hina.crewforge.service.TenantService;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
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

    @Autowired
    private ProjectMapper projectMapper;

    @Autowired
    private UserMapper userMapper;

    @Override
    public PageResult<TenantVO> page(TenantQueryParam tenantQueryParam) {
        // 我的团队: 以 sys_user_tenant 为唯一权威来源, 按 JWT userId 查我加入的团队 id
        Long userId = BaseContext.getCurrentUserId();
        List<Long> tenantIds = userTenantMapper.selectList(new LambdaQueryWrapper<UserTenant>()
                        .eq(UserTenant::getUserId, userId)
                        .eq(UserTenant::getStatus, 1))
                .stream().map(UserTenant::getTenantId).collect(Collectors.toList());
        if (tenantIds.isEmpty()) {
            return new PageResult<>(0L, Collections.emptyList());
        }

        PageHelper.startPage(tenantQueryParam.getPage(), tenantQueryParam.getPageSize());

        List<Tenant> list = tenantMapper.list(tenantQueryParam, tenantIds);
        Page<Tenant> p = (Page<Tenant>)list;

        // 项目数: 一次分组查本页所有团队的团队项目数, 避免 N+1
        Map<Long, Long> projectCounts = countTeamProjects(p.getResult().stream()
                .map(Tenant::getId).collect(Collectors.toList()));

        List<TenantVO> voList = p.getResult().stream()
                .map(t -> toVO(t, projectCounts)).collect(Collectors.toList());

        return new PageResult<>(p.getTotal(), voList);
    }

    /** 一次分组查询出多个团队的项目数(COUNT + GROUP BY tenant_id) */
    private Map<Long, Long> countTeamProjects(List<Long> tenantIds) {
        Map<Long, Long> counts = new HashMap<>();
        if (tenantIds.isEmpty()) {
            return counts;
        }
        QueryWrapper<Project> wrapper = new QueryWrapper<>();
        wrapper.select("tenant_id", "COUNT(*) AS cnt")
                .in("tenant_id", tenantIds)
                .groupBy("tenant_id");
        for (Map<String, Object> row : projectMapper.selectMaps(wrapper)) {
            Long tenantId = ((Number) row.get("tenant_id")).longValue();
            Long cnt = ((Number) row.get("cnt")).longValue();
            counts.put(tenantId, cnt);
        }
        return counts;
    }

    @Override
    public Long create(TenantDTO dto) {
        Tenant entity = new Tenant();
        BeanUtils.copyProperties(dto, entity);
        LocalDateTime now = LocalDateTime.now();
        entity.setCreateTime(now);
        entity.setUpdateTime(now);
        entity.setOwnerId(BaseContext.getCurrentUserId());
        // 当前成员数 = 1（创建者自己）
        entity.setMembers(1);
        // 容量上限: 不传默认 DEFAULT_MAX_MEMBERS
        if (entity.getMaxMembers() == null) {
            entity.setMaxMembers(Tenant.DEFAULT_MAX_MEMBERS);
        }
        // 状态默认启用（防前端不传导致 status=null 落库）
        if (entity.getStatus() == null) {
            entity.setStatus(1);
        }
        // 生成 20 位邀请码(UUID 截取), 万一撞了唯一索引就让用户重试
        entity.setInvitationCode(UUID.randomUUID().toString().replace("-", "").substring(0, 20));
        tenantMapper.insert(entity);
        // 创建者自动成为成员（sys_user_tenant 是"我的团队"查询的权威来源）
        UserTenant ut = new UserTenant();
        ut.setUserId(entity.getOwnerId());
        ut.setTenantId(entity.getId());
        ut.setStatus(1);
        ut.setCreateTime(now);
        userTenantMapper.insert(ut);
        return entity.getId();
    }

    @Override
    public void update(Long id, TenantDTO dto) {
        // 1. 存在 + 仅创建者(管理员)可改
        Tenant existing = tenantMapper.selectById(id);
        if (existing == null) {
            throw new BaseException("团队不存在: " + id);
        }
        if (!existing.getOwnerId().equals(BaseContext.getCurrentUserId())) {
            throw new BaseException("无权修改他人团队");
        }
        // 2. 更新（MP updateById 只更新非 null 字段; members 当前数 DTO 没有, 不会被改）
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
        // 1. 存在 + 仅创建者(管理员)可删
        Tenant existing = tenantMapper.selectById(id);
        if (existing == null) {
            throw new BaseException("团队不存在: " + id);
        }
        if (!existing.getOwnerId().equals(BaseContext.getCurrentUserId())) {
            throw new BaseException("无权删除他人团队");
        }
        // 2. BaseMapper 自带: @TableLogic 自动转逻辑删除(deleted=1)
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
        // 0. 仅团队创建者(管理员)可审批
        Tenant tenant = tenantMapper.selectById(apply.getTenantId());
        if (!tenant.getOwnerId().equals(BaseContext.getCurrentUserId())) {
            throw new BaseException("无权审批他人团队的申请");
        }
        // 1. 校验容量上限(max_members 为软限制, 允许超出 MAX_MEMBERS_BUFFER 人; 超出后提醒)
        Long memberCount = userTenantMapper.selectCount(new LambdaQueryWrapper<UserTenant>()
                .eq(UserTenant::getTenantId, apply.getTenantId())
                .eq(UserTenant::getStatus, 1));
        int limit = (tenant.getMaxMembers() != null ? tenant.getMaxMembers() : Tenant.DEFAULT_MAX_MEMBERS)
                + Tenant.MAX_MEMBERS_BUFFER;
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
        // 3.1 当前成员数 +1（与实体 members 字段同步）
        Tenant update = new Tenant();
        update.setId(tenant.getId());
        update.setMembers(tenant.getMembers() + 1);
        update.setUpdateTime(LocalDateTime.now());
        tenantMapper.updateById(update);
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
        // 0. 仅团队创建者(管理员)可审批
        Tenant tenant = tenantMapper.selectById(apply.getTenantId());
        if (!tenant.getOwnerId().equals(BaseContext.getCurrentUserId())) {
            throw new BaseException("无权审批他人团队的申请");
        }
        // 申请状态 → 已拒绝(用户可重新申请)
        apply.setStatus(2);
        tenantApplyMapper.updateById(apply);
    }

    @Override
    public List<TenantApplyVO> listApply(Long tenantId) {
        // 仅团队创建者(管理员)可查看申请列表
        Tenant tenant = tenantMapper.selectById(tenantId);
        if (tenant == null) {
            throw new BaseException("团队不存在: " + tenantId);
        }
        if (!tenant.getOwnerId().equals(BaseContext.getCurrentUserId())) {
            throw new BaseException("无权查看他人团队的申请");
        }
        List<TenantApply> applies = tenantApplyMapper.selectList(new LambdaQueryWrapper<TenantApply>()
                .eq(TenantApply::getTenantId, tenantId)
                .orderByDesc(TenantApply::getCreateTime));
        if (applies.isEmpty()) {
            return Collections.emptyList();
        }
        // 联查申请人姓名（一次批量查，避免 N+1）
        List<Long> userIds = applies.stream().map(TenantApply::getUserId).distinct().collect(Collectors.toList());
        Map<Long, User> userMap = userMapper.selectBatchIds(userIds).stream()
                .collect(Collectors.toMap(User::getId, u -> u));
        return applies.stream().map(a -> {
            TenantApplyVO vo = new TenantApplyVO();
            BeanUtils.copyProperties(a, vo);
            User u = userMap.get(a.getUserId());
            if (u != null) {
                vo.setUsername(u.getUsername());
                vo.setRealName(u.getRealName());
            }
            return vo;
        }).collect(Collectors.toList());
    }

    private TenantVO toVO(Tenant tenant, Map<Long, Long> projectCounts) {
        TenantVO vo = new TenantVO();
        BeanUtils.copyProperties(tenant, vo);
        vo.setProjectCount(projectCounts.getOrDefault(tenant.getId(), 0L));
        return vo;
    }

    private TenantVO toVO(Tenant tenant) {
        return toVO(tenant, Collections.emptyMap());
    }
}
