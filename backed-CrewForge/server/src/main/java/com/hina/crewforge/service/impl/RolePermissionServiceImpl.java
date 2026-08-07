package com.hina.crewforge.service.impl;

import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import com.hina.crewforge.mapper.RolePermissionMapper;
import com.hina.crewforge.pojo.entity.RolePermission;
import com.hina.crewforge.service.RolePermissionService;
import org.springframework.stereotype.Service;

@Service
public class RolePermissionServiceImpl extends ServiceImpl<RolePermissionMapper, RolePermission> implements RolePermissionService {
}
