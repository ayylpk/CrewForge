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
 * 说明: 用户 CRUD 之外，还要处理两个关联关系——
 *       · 用户-团队 (sys_user_tenant): 创建用户时加入团队
 *       · 用户-角色 (sys_user_role): 创建用户时分配角色
 */
public interface UserService extends IService<User> {

    /**
     * 分页查询用户（附带所属团队列表）
     * 注意: PageResult 的泛型 T 是元素类型，records 本身是 List<T>
     */
    PageResult<UserVO> pageUsers(UserQueryParam userQueryParam);

    /**
     * 新增用户: BCrypt 加密密码 + 关联团队 + 分配角色
     */
    void createUser(UserDTO dto);

    /**
     * 修改用户（密码为空表示不修改）
     */
    void updateUser(Long id, UserDTO dto);

    /**
     * 查询单个用户（附带所属团队列表）
     */
    UserVO getUserById(Long id);
}
