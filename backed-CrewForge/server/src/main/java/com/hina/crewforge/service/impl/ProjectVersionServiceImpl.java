package com.hina.crewforge.service.impl;

import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import com.hina.crewforge.mapper.ProjectVersionMapper;
import com.hina.crewforge.pojo.entity.ProjectVersion;
import com.hina.crewforge.service.ProjectVersionService;
import org.springframework.stereotype.Service;

@Service
public class ProjectVersionServiceImpl extends ServiceImpl<ProjectVersionMapper, ProjectVersion> implements ProjectVersionService {
}
