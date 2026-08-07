package com.hina.crewforge.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.hina.crewforge.pojo.QueryParam.TenantQueryParam;
import com.hina.crewforge.pojo.entity.Tenant;
import org.apache.ibatis.annotations.Mapper;

import java.util.List;

@Mapper
public interface TenantMapper extends BaseMapper<Tenant> {
    /** 分页查询(自定义 XML); 增删改查走 BaseMapper 自带 */
    List<Tenant> list(TenantQueryParam tenantQueryParam);
}
