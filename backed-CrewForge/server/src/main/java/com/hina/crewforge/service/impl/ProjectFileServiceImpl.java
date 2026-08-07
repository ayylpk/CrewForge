package com.hina.crewforge.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import com.hina.crewforge.mapper.ProjectFileMapper;
import com.hina.crewforge.pojo.dto.ProjectFileDTO;
import com.hina.crewforge.pojo.entity.ProjectFile;
import com.hina.crewforge.pojo.vo.ProjectFileVO;
import com.hina.crewforge.service.ProjectFileService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.BeanUtils;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.List;
import java.util.stream.Collectors;

@Service
@Slf4j
public class ProjectFileServiceImpl extends ServiceImpl<ProjectFileMapper, ProjectFile> implements ProjectFileService {

    @Override
    public List<ProjectFileVO> listByProjectId(Long projectId) {
        // 列表查询: 不查 file_content 大字段, 只回元信息(前端拼文件树用, 点开文件再查详情)
        LambdaQueryWrapper<ProjectFile> wrapper = new LambdaQueryWrapper<>();
        wrapper.eq(ProjectFile::getProjectId, projectId)
               .select(ProjectFile::getId, ProjectFile::getProjectId, ProjectFile::getFilePath,
                       ProjectFile::getFileType, ProjectFile::getUserModified,
                       ProjectFile::getCreateTime, ProjectFile::getUpdateTime)
               .orderByAsc(ProjectFile::getFilePath);
        List<ProjectFile> list = baseMapper.selectList(wrapper);
        return list.stream().map(this::toVO).collect(Collectors.toList());
    }

    @Override
    public void create(ProjectFileDTO dto) {
        LocalDateTime now = LocalDateTime.now();
        // 同一项目同路径已存在 → 覆盖更新(Agent 重新生成场景, 保留 user_modified 标记)
        ProjectFile exist = baseMapper.selectOne(new LambdaQueryWrapper<ProjectFile>()
                .eq(ProjectFile::getProjectId, dto.getProjectId())
                .eq(ProjectFile::getFilePath, dto.getFilePath()));
        if (exist != null) {
            exist.setFileContent(dto.getFileContent());
            exist.setFileType(dto.getFileType());
            exist.setUpdateTime(now);
            baseMapper.updateById(exist);
            return;
        }
        // 不存在 → 插入, 初始 user_modified=0(Agent 生成)
        ProjectFile entity = new ProjectFile();
        BeanUtils.copyProperties(dto, entity);
        entity.setUserModified(0);
        entity.setCreateTime(now);
        entity.setUpdateTime(now);
        baseMapper.insert(entity);
    }

    @Override
    public void update(Long id, ProjectFileDTO dto) {
        ProjectFile entity = new ProjectFile();
        BeanUtils.copyProperties(dto, entity);
        entity.setId(id);
        entity.setUserModified(1); // 用户编辑过 → Agent 不再覆盖
        entity.setUpdateTime(LocalDateTime.now());
        baseMapper.updateById(entity);
    }

    @Override
    public ProjectFileVO getById(Long id) {
        ProjectFile entity = baseMapper.selectById(id);
        return toVO(entity);
    }

    private ProjectFileVO toVO(ProjectFile entity) {
        ProjectFileVO vo = new ProjectFileVO();
        BeanUtils.copyProperties(entity, vo);
        return vo;
    }
}
