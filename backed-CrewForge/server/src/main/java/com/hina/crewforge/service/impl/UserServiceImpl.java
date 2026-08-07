package com.hina.crewforge.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import com.github.pagehelper.Page;
import com.github.pagehelper.PageHelper;
import com.hina.crewforge.common.constant.MessageConstant;
import com.hina.crewforge.common.exception.AccountNotFoundException;
import com.hina.crewforge.common.exception.BaseException;
import com.hina.crewforge.common.exception.ParamErrorException;
import com.hina.crewforge.common.result.PageResult;
import com.hina.crewforge.mapper.TenantMapper;
import com.hina.crewforge.mapper.UserMapper;
import com.hina.crewforge.mapper.UserRoleMapper;
import com.hina.crewforge.mapper.UserTenantMapper;
import com.hina.crewforge.pojo.QueryParam.UserQueryParam;
import com.hina.crewforge.pojo.dto.UserDTO;
import com.hina.crewforge.pojo.entity.Tenant;
import com.hina.crewforge.pojo.entity.User;
import com.hina.crewforge.pojo.entity.UserRole;
import com.hina.crewforge.pojo.entity.UserTenant;
import com.hina.crewforge.pojo.vo.UserVO;
import com.hina.crewforge.service.UserService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * 用户管理服务实现
 *
 * 多对多说明: 用户不绑死单个团队，创建时可选 teamId 关联一个团队；
 *             用户的团队列表通过 sys_user_tenant 查询，显示时批量组装
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class UserServiceImpl extends ServiceImpl<UserMapper, User> implements UserService {

    /** 默认角色 ID: 3 = viewer（见 SQL 种子数据 sys_role） */
    private static final Long DEFAULT_ROLE_ID = 3L;

    private final UserTenantMapper userTenantMapper;
    private final TenantMapper tenantMapper;
    private final UserRoleMapper userRoleMapper;

    /** BCrypt 编码器（无状态，可安全复用单实例） */
    private final BCryptPasswordEncoder passwordEncoder = new BCryptPasswordEncoder();

    @Override
    public PageResult<UserVO> pageUsers(UserQueryParam userQueryParam) {
        // 1. PageHelper 分页（只对紧接着的第一次查询生效）
        PageHelper.startPage(userQueryParam.getPage(), userQueryParam.getPageSize());

        // 2. 条件查询（用户名模糊搜索 / 状态过滤，可选）
        LambdaQueryWrapper<User> wrapper = new LambdaQueryWrapper<>();
        if (StringUtils.hasText(userQueryParam.getUsername())) {
            wrapper.like(User::getUsername, userQueryParam.getUsername());
        }
        if (userQueryParam.getStatus() != null) {
            wrapper.eq(User::getStatus, userQueryParam.getStatus());
        }
        wrapper.orderByDesc(User::getCreateTime);
        List<User> users = baseMapper.selectList(wrapper);
        // PageHelper 拦截后返回的 List 实际是 Page 对象, 强转取 total
        Page<User> p = (Page<User>) users;

        // 3. 组装返回（附带每个用户的团队列表）
        List<UserVO> vos = p.getResult().stream().map(this::toVO).collect(Collectors.toList());
        fillTeams(vos);

        return new PageResult<>(p.getTotal(), vos);
    }

    @Override
    @Transactional
    public void createUser(UserDTO dto) {
        // 1. 校验用户名唯一（登录账号不能重复）
        Long count = baseMapper.selectCount(
                new LambdaQueryWrapper<User>().eq(User::getUsername, dto.getUsername()));
        if (count != null && count > 0) {
            throw new BaseException("用户名已存在");
        }

        // 2. 密码 BCrypt 加密后入库
        User user = new User();
        user.setUsername(dto.getUsername());
        user.setPassword(passwordEncoder.encode(dto.getPassword()));
        user.setRealName(dto.getRealName());
        user.setEmail(dto.getEmail());
        user.setPhone(dto.getPhone());
        user.setStatus(dto.getStatus() == null ? 1 : dto.getStatus());
        baseMapper.insert(user);

        // 3. 可选: 加入团队（sys_user_tenant，状态=正常成员）
        if (dto.getTeamId() != null) {
            UserTenant ut = new UserTenant();
            ut.setUserId(user.getId());
            ut.setTenantId(dto.getTeamId());
            ut.setStatus(1);
            userTenantMapper.insert(ut);
        }

        // 4. 分配角色（默认 viewer）
        UserRole ur = new UserRole();
        ur.setUserId(user.getId());
        ur.setRoleId(dto.getRoleId() == null ? DEFAULT_ROLE_ID : dto.getRoleId());
        userRoleMapper.insert(ur);

        log.info("创建用户: id={}, username={}, teamId={}", user.getId(), user.getUsername(), dto.getTeamId());
    }

    @Override
    @Transactional
    public void updateUser(Long id, UserDTO dto) {
        // 1. 校验用户存在
        User user = baseMapper.selectById(id);
        if (user == null) {
            throw new AccountNotFoundException();
        }

        // 2. 有值才更新（密码为空表示不修改）
        User update = new User();
        update.setId(id);
        update.setRealName(dto.getRealName());
        update.setEmail(dto.getEmail());
        update.setPhone(dto.getPhone());
        if (dto.getStatus() != null) {
            update.setStatus(dto.getStatus());
        }
        if (StringUtils.hasText(dto.getPassword())) {
            update.setPassword(passwordEncoder.encode(dto.getPassword()));
        }
        baseMapper.updateById(update);
        log.info("修改用户: id={}", id);
    }

    @Override
    public UserVO getUserById(Long id) {
        User user = baseMapper.selectById(id);
        if (user == null) {
            throw new AccountNotFoundException();
        }
        UserVO vo = toVO(user);
        fillTeams(Collections.singletonList(vo));
        return vo;
    }

    /* ========== 私有工具 ========== */

    /** 实体 → VO（不含团队列表） */
    private UserVO toVO(User user) {
        UserVO vo = new UserVO();
        vo.setId(user.getId());
        vo.setUsername(user.getUsername());
        vo.setRealName(user.getRealName());
        vo.setEmail(user.getEmail());
        vo.setPhone(user.getPhone());
        vo.setStatus(user.getStatus());
        vo.setCreateTime(user.getCreateTime());
        return vo;
    }

    /**
     * 批量组装用户的团队列表（一次查询 N 条，避免循环查库）
     * 流程: 查关联表(sys_user_tenant) → 批量查团队名(sys_tenant) → 按 userId 分组填入 VO
     */
    private void fillTeams(List<UserVO> vos) {
        if (vos.isEmpty()) {
            return;
        }
        List<Long> userIds = vos.stream().map(UserVO::getId).collect(Collectors.toList());

        // 1. 查全部关联（user_id in ...）
        List<UserTenant> uts = userTenantMapper.selectList(
                new LambdaQueryWrapper<UserTenant>().in(UserTenant::getUserId, userIds));
        if (uts.isEmpty()) {
            return;
        }

        // 2. userId → [teamIds] 分组
        Map<Long, List<Long>> userIdToTeamIds = uts.stream().collect(Collectors.groupingBy(
                UserTenant::getUserId,
                Collectors.mapping(UserTenant::getTenantId, Collectors.toList())));

        // 3. 批量查团队名，teamId → teamName 映射
        List<Long> teamIds = uts.stream().map(UserTenant::getTenantId).distinct().collect(Collectors.toList());
        Map<Long, String> teamIdToName = tenantMapper.selectBatchIds(teamIds).stream()
                .collect(Collectors.toMap(Tenant::getId, Tenant::getName));

        // 4. 填入每个 VO
        for (UserVO vo : vos) {
            List<Long> ids = userIdToTeamIds.getOrDefault(vo.getId(), Collections.emptyList());
            vo.setTeamIds(ids);
            vo.setTeamNames(ids.stream().map(teamIdToName::get).collect(Collectors.toList()));
        }
    }
}
