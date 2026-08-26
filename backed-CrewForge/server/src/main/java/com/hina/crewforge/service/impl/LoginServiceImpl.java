package com.hina.crewforge.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.hina.crewforge.common.exception.AccountLockedException;
import com.hina.crewforge.common.exception.AccountNotFoundException;
import com.hina.crewforge.common.exception.PasswordErrorException;
import com.hina.crewforge.common.properties.JwtProperties;
import com.hina.crewforge.common.result.Result;
import com.hina.crewforge.common.utils.JwtUtil;
import com.hina.crewforge.mapper.UserMapper;
import com.hina.crewforge.pojo.entity.User;
import com.hina.crewforge.pojo.vo.LoginVO;
import com.hina.crewforge.service.LoginService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;

/**
 * 登录服务实现
 *
 * 流程: 查用户(用户名) → 校验状态 → BCrypt 校验密码 → 签发 JWT(只含 userId) → 返回 LoginVO
 *
 * 错误用 throw 异常 → 由 GlobalExceptionHandler 统一转成对应 HTTP 状态码:
 *   账号不存在/密码错误 → 400 · 账号锁定 → 403
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class LoginServiceImpl implements LoginService {

    private final UserMapper userMapper;
    private final JwtProperties jwtProperties;

    /** BCrypt 编码器（无状态，可安全复用单实例） */
    private final BCryptPasswordEncoder passwordEncoder = new BCryptPasswordEncoder();

    @Override
    public Result<LoginVO> login(String username, String password) {
        // 1. 按用户名查用户
        User user = userMapper.selectOne(
                new LambdaQueryWrapper<User>().eq(User::getUsername, username));
        if (user == null) {
            throw new AccountNotFoundException();
        }

        // 2. 校验账号状态
        if (user.getStatus() != null && user.getStatus() == 0) {
            throw new AccountLockedException();
        }

        // 3. BCrypt 校验密码（库里存的是 hash，重算比对）
        if (!passwordEncoder.matches(password, user.getPassword())) {
            throw new PasswordErrorException();
        }

        // 4. 签发 JWT（只含 userId）
        String token = JwtUtil.createJwt(
                jwtProperties.getUserSecretKey(), jwtProperties.getUserTtl(), user.getId());
        log.info("登录成功: userId={}", user.getId());

        // 5. 组装返回
        return Result.success(LoginVO.builder()
                .accessToken(token)
                .userId(user.getId())
                .username(user.getUsername())
                .realName(user.getRealName())
                .build());
    }
}
