package com.hina.crewforge.service.impl;

import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import com.hina.crewforge.mapper.RoleMapper;
import com.hina.crewforge.pojo.entity.Role;
import com.hina.crewforge.service.RoleService;
import org.springframework.stereotype.Service;

@Service
public class RoleServiceImpl extends ServiceImpl<RoleMapper, Role> implements RoleService {
}
