package com.hina.crewforge.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.hina.crewforge.pojo.QueryParam.TenantQueryParam;
import com.hina.crewforge.pojo.entity.Tenant;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.util.List;

@Mapper
public interface TenantMapper extends BaseMapper<Tenant> {
    /** 分页查询(自定义 XML); 增删改查走 BaseMapper 自带
     * tenantIds: 我的团队模式过滤用(id IN ...), 传 null 查全部 */
    List<Tenant> list(@Param("param") TenantQueryParam tenantQueryParam, @Param("tenantIds") List<Long> tenantIds);
}
