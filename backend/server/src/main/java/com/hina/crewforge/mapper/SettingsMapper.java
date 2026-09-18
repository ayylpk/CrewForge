package com.hina.crewforge.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.hina.crewforge.pojo.entity.Settings;
import org.apache.ibatis.annotations.Mapper;

/**
 * 运行时设置 Mapper（sys_settings，单行 id=1）
 */
@Mapper
public interface SettingsMapper extends BaseMapper<Settings> {
}
