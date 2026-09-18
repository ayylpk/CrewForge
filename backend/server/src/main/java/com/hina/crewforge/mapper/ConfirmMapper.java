package com.hina.crewforge.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.hina.crewforge.pojo.entity.Confirm;
import org.apache.ibatis.annotations.Mapper;

/**
 * 确认门问答 Mapper（sys_confirm）—— CRUD 全走 BaseMapper + Wrapper，无手写 SQL
 */
@Mapper
public interface ConfirmMapper extends BaseMapper<Confirm> {
}
