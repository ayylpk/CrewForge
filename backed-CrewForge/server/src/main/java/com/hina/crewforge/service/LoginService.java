package com.hina.crewforge.service;

import com.hina.crewforge.common.result.Result;
import com.hina.crewforge.pojo.vo.LoginVO;

/**
 * 登录服务
 */
public interface LoginService {

    /**
     * 登录：BCrypt 校验密码 → 签发 JWT（只含 userId）→ 返回用户信息 + 团队列表
     */
    Result<LoginVO> login(String username, String password);
}
