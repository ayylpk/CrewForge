package com.hina.crewforge.service.impl;

import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import com.hina.crewforge.mapper.PermissionMapper;
import com.hina.crewforge.pojo.entity.Permission;
import com.hina.crewforge.service.PermissionService;
import org.springframework.stereotype.Service;

@Service
public class PermissionServiceImpl extends ServiceImpl<PermissionMapper, Permission> implements PermissionService {
}
