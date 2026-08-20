package com.hina.crewforge.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.hina.crewforge.common.exception.BaseException;
import com.hina.crewforge.mapper.ProjectFileMapper;
import com.hina.crewforge.pojo.dto.ProjectFileDTO;
import com.hina.crewforge.pojo.entity.ProjectFile;
import com.hina.crewforge.pojo.vo.ProjectFileVO;
import com.hina.crewforge.service.ProjectFileService;
import com.hina.crewforge.service.ProjectService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

@Service
@Slf4j
public class ProjectFileServiceImpl extends ServiceImpl<ProjectFileMapper, ProjectFile> implements ProjectFileService {

    @Autowired
    private ProjectService projectService;

    @Autowired
    private StringRedisTemplate redisTemplate;

    @Autowired
    private ObjectMapper objectMapper;

    /** 缓存 TTL（秒）：查询侧每次写入；Agent 修改侧显式清除为主失效路径，TTL 仅兜底防堆积 */
    private static final long CACHE_TTL_SECONDS = 3600;

    private String listKey(Long projectId) { return "pf:list:" + projectId; }
    private String detailKey(Long projectId, Long id) { return "pf:detail:" + projectId + ":" + id; }

    @Override
    public List<ProjectFileVO> listByProjectId(Long projectId) {
        // 缓存优先
        String key = listKey(projectId);
        String cached = redisTemplate.opsForValue().get(key);
        if (cached != null) {
            try {
                return objectMapper.readValue(cached, new TypeReference<List<ProjectFileVO>>() {});
            } catch (Exception e) {
                log.warn("项目文件列表缓存解析失败，回源: {}", e.getMessage());
            }
        }
        // 列表查询: 不查 file_content 大字段, 只回元信息(前端拼文件树用, 点开文件再查详情)
        LambdaQueryWrapper<ProjectFile> wrapper = new LambdaQueryWrapper<>();
        wrapper.eq(ProjectFile::getProjectId, projectId)
               .select(ProjectFile::getId, ProjectFile::getProjectId, ProjectFile::getFilePath,
                       ProjectFile::getFileType, ProjectFile::getUserModified,
                       ProjectFile::getCreateTime, ProjectFile::getUpdateTime)
               .orderByAsc(ProjectFile::getFilePath);
        List<ProjectFile> list = baseMapper.selectList(wrapper);
        List<ProjectFileVO> vos = list.stream().map(this::toVO).collect(Collectors.toList());
        // 查询侧：每次都写入缓存（agent 修改时才清）
        try {
            redisTemplate.opsForValue().set(key, objectMapper.writeValueAsString(vos), Duration.ofSeconds(CACHE_TTL_SECONDS));
        } catch (Exception e) {
            log.warn("项目文件列表缓存写入失败: {}", e.getMessage());
        }
        return vos;
    }

    /** 写操作后清缓存：list + 该项目的 detail */
    private void evictCache(Long projectId) {
        try {
            redisTemplate.delete(listKey(projectId));
            Set<String> details = redisTemplate.keys("pf:detail:" + projectId + ":*");
            if (details != null && !details.isEmpty()) {
                redisTemplate.delete(details);
            }
        } catch (Exception e) {
            log.warn("项目文件缓存清理失败: {}", e.getMessage());
        }
    }

    @Override
    public void clearCache(Long projectId) {
        evictCache(projectId);
        log.info("项目文件缓存已清除: projectId={}", projectId);
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
        } else {
            // 不存在 → 插入, 初始 user_modified=0(Agent 生成)
            ProjectFile entity = new ProjectFile();
            BeanUtils.copyProperties(dto, entity);
            entity.setUserModified(0);
            entity.setCreateTime(now);
            entity.setUpdateTime(now);
            baseMapper.insert(entity);
        }
        evictCache(dto.getProjectId());
    }

    @Override
    public void update(Long id, ProjectFileDTO dto) {
        ProjectFile entity = new ProjectFile();
        BeanUtils.copyProperties(dto, entity);
        entity.setId(id);
        entity.setUserModified(1); // 用户编辑过 → Agent 不再覆盖
        entity.setUpdateTime(LocalDateTime.now());
        baseMapper.updateById(entity);
        // 更新前查一次拿 projectId（DTO 里没有时）
        if (dto.getProjectId() != null) {
            evictCache(dto.getProjectId());
        } else {
            ProjectFile exist = baseMapper.selectById(id);
            if (exist != null) evictCache(exist.getProjectId());
        }
    }

    @Override
    public ProjectFileVO getById(Long id) {
        // 缓存优先（key 带 projectId 便于修改侧按项目清）
        ProjectFile entity0 = baseMapper.selectById(id);
        if (entity0 == null) {
            throw new BaseException("文件不存在: " + id);
        }
        String key = detailKey(entity0.getProjectId(), id);
        String cached = redisTemplate.opsForValue().get(key);
        if (cached != null) {
            try {
                ProjectFileVO vo = objectMapper.readValue(cached, ProjectFileVO.class);
                // 缓存命中也要做归属校验（防 IDOR 越权读取）
                projectService.getById(vo.getProjectId());
                return vo;
            } catch (Exception e) {
                log.warn("项目文件详情缓存解析失败，回源: {}", e.getMessage());
            }
        }
        ProjectFile entity = baseMapper.selectById(id);
        if (entity == null) {
            throw new BaseException("文件不存在: " + id);
        }
        // 文件归属项目 → 借项目归属校验（个人=创建者, 团队=成员），防 IDOR 越权读取
        projectService.getById(entity.getProjectId());
        ProjectFileVO vo = toVO(entity);
        // 查询侧：每次都写入缓存
        try {
            redisTemplate.opsForValue().set(key, objectMapper.writeValueAsString(vo), Duration.ofSeconds(CACHE_TTL_SECONDS));
        } catch (Exception e) {
            log.warn("项目文件详情缓存写入失败: {}", e.getMessage());
        }
        return vo;
    }

    private ProjectFileVO toVO(ProjectFile entity) {
        ProjectFileVO vo = new ProjectFileVO();
        BeanUtils.copyProperties(entity, vo);
        return vo;
    }
}
