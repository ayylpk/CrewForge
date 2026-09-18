package com.hina.crewforge.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.hina.crewforge.pojo.entity.PermissionRule;
import org.apache.ibatis.annotations.Mapper;

/** 命令执行权限规则 Mapper（sys_permission_rule）—— CRUD 全走 BaseMapper + Wrapper，无手写 SQL */
@Mapper
public interface PermissionRuleMapper extends BaseMapper<PermissionRule> {
}
