package com.hina.crewforge.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.hina.crewforge.pojo.entity.ProjectRun;
import org.apache.ibatis.annotations.Mapper;

/**
 * 项目运行活账 Mapper（sys_project_run）—— CRUD 全走 BaseMapper，无手写 SQL
 */
@Mapper
public interface ProjectRunMapper extends BaseMapper<ProjectRun> {
}
