package com.hina.crewforge.service;

import com.baomidou.mybatisplus.extension.service.IService;
import com.hina.crewforge.common.result.PageResult;
import com.hina.crewforge.pojo.QueryParam.UserQueryParam;
import com.hina.crewforge.pojo.dto.UserDTO;
import com.hina.crewforge.pojo.entity.User;
import com.hina.crewforge.pojo.vo.UserVO;

import java.util.List;

/**
 * 用户管理服务
 * ⚠️ 砍掉团队功能后：移除团队相关注释；砍掉 RBAC 后：移除角色相关注释
 */
public interface UserService extends IService<User> {

    /**
     * 分页查询用户
     */
    PageResult<UserVO> pageUsers(UserQueryParam userQueryParam);

    /**
     * 新增用户: BCrypt 加密密码
     */
    void createUser(UserDTO dto);

    /**
     * 修改用户（密码为空表示不修改）
     */
    void updateUser(Long id, UserDTO dto);

    /**
     * 查询单个用户
     */
    UserVO getUserById(Long id);
}
