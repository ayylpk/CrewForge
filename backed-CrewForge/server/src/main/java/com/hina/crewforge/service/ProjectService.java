package com.hina.crewforge.service;

import com.baomidou.mybatisplus.extension.service.IService;
import com.hina.crewforge.common.result.PageResult;
import com.hina.crewforge.pojo.QueryParam.ProjectQueryParam;
import com.hina.crewforge.pojo.dto.ProjectDTO;
import com.hina.crewforge.pojo.entity.Project;
import com.hina.crewforge.pojo.vo.ProjectVO;

public interface ProjectService extends IService<Project> {

    /**
     * 分页查询项目
     * projectType=1(个人): 按 create_user = userId 过滤
     * projectType=2(团队): 按 tenant_id = tenantId 过滤
     */
    PageResult<ProjectVO> page(ProjectQueryParam projectQueryParam);

    /**
     * 新增项目: 默认个人项目 + draft 状态 + 混合确认模式
     */
    void create(ProjectDTO dto);

    /**
     * 修改项目 (MP updateById 只更新非 null 字段)
     */
    void update(Long id, ProjectDTO dto);

    /**
     * 查询单个项目
     */
    ProjectVO getById(Long id);
}
