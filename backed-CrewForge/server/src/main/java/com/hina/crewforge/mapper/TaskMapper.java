package com.hina.crewforge.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.hina.crewforge.pojo.entity.Task;
import org.apache.ibatis.annotations.Mapper;

/**
 * 任务 Mapper（sys_task）—— CRUD 全走 BaseMapper + Wrapper，无手写 SQL
 */
@Mapper
public interface TaskMapper extends BaseMapper<Task> {
}
