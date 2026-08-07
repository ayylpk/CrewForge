package com.hina.crewforge.service;

import com.baomidou.mybatisplus.extension.service.IService;
import com.hina.crewforge.pojo.dto.ProjectFileDTO;
import com.hina.crewforge.pojo.entity.ProjectFile;
import com.hina.crewforge.pojo.vo.ProjectFileVO;

import java.util.List;

public interface ProjectFileService extends IService<ProjectFile> {

    /**
     * 项目文件列表(按 projectId 全量返回, 不查 file_content 大字段——列表拼文件树用)
     */
    List<ProjectFileVO> listByProjectId(Long projectId);

    /**
     * 新增文件: 内容以 String 传入; 同一项目同路径已存在则覆盖更新(Agent 重新生成场景)
     */
    void create(ProjectFileDTO dto);

    /**
     * 修改文件内容(用户编辑): 更新后标记 user_modified=1, Agent 不再覆盖
     */
    void update(Long id, ProjectFileDTO dto);

    /**
     * 查询单个文件(含完整内容, 点开文件时调用)
     */
    ProjectFileVO getById(Long id);
}
