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
import com.hina.crewforge.mapper.UserMapper;
import com.hina.crewforge.pojo.QueryParam.UserQueryParam;
import com.hina.crewforge.pojo.dto.UserDTO;
import com.hina.crewforge.pojo.entity.User;
import com.hina.crewforge.pojo.vo.UserVO;
import com.hina.crewforge.service.UserService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.util.List;
import java.util.stream.Collectors;

/**
 * 用户管理服务实现
 * ⚠️ 砍掉团队功能后：移除 fillTeams / TenantMapper / UserTenantMapper 依赖
 * ⚠️ 砍掉 RBAC 后：移除角色分配逻辑
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class UserServiceImpl extends ServiceImpl<UserMapper, User> implements UserService {

    @Autowired
    private UserMapper userMapper;

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

        // 3. 组装返回
        List<UserVO> vos = p.getResult().stream().map(this::toVO).collect(Collectors.toList());

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

        log.info("创建用户: id={}, username={}", user.getId(), user.getUsername());
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
        return toVO(user);
    }

    /* ========== 私有工具 ========== */

    /** 实体 → VO */
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
}
