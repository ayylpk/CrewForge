package com.hina.crewforge.service.impl;

import com.github.pagehelper.Page;
import com.github.pagehelper.PageHelper;
import com.hina.crewforge.common.context.BaseContext;
import com.hina.crewforge.common.exception.BaseException;
import com.hina.crewforge.common.result.PageResult;
import com.hina.crewforge.common.template.AgentTemplate;
import com.hina.crewforge.mapper.AgentEdgeMapper;
import com.hina.crewforge.mapper.AgentNodeMapper;
import com.hina.crewforge.mapper.AgentPoolMapper;
import com.hina.crewforge.mapper.ProjectAgentMapper;
import com.hina.crewforge.mapper.ProjectAgentNodeMapper;
import com.hina.crewforge.pojo.QueryParam.ProjectAgentQueryParam;
import com.hina.crewforge.pojo.dto.ProjectAgentCopyDTO;
import com.hina.crewforge.pojo.dto.ProjectAgentDTO;
import com.hina.crewforge.pojo.entity.AgentEdge;
import com.hina.crewforge.pojo.entity.AgentNode;
import com.hina.crewforge.pojo.entity.AgentPool;
import com.hina.crewforge.pojo.entity.ProjectAgent;
import com.hina.crewforge.pojo.entity.ProjectAgentNode;
import com.hina.crewforge.pojo.vo.ProjectAgentVO;
import com.hina.crewforge.service.ProjectAgentService;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.*;
import java.util.stream.Collectors;

@Service
public class ProjectAgentServiceImpl implements ProjectAgentService {

    @Autowired
    private ProjectAgentMapper projectAgentMapper;

    @Autowired
    private AgentPoolMapper agentPoolMapper;

    @Autowired
    private AgentNodeMapper agentNodeMapper;

    @Autowired
    private ProjectAgentNodeMapper projectAgentNodeMapper;

    @Autowired
    private AgentEdgeMapper agentEdgeMapper;

    @Override
    public PageResult<ProjectAgentVO> page(ProjectAgentQueryParam projectAgentQueryParam) {
        // ⚠️ 不信任前端传的 userId, 从 JWT 解析当前登录用户
        projectAgentQueryParam.setUserId(BaseContext.getCurrentUserId());
        PageHelper.startPage(projectAgentQueryParam.getPage(),projectAgentQueryParam.getPageSize());

        List<ProjectAgent> list = projectAgentMapper.list(projectAgentQueryParam);
        Page<ProjectAgent> p = (Page<ProjectAgent>)list;

        List<ProjectAgentVO> voList = p.getResult().stream().map(this::toVO).collect(Collectors.toList());

        return new PageResult<>(p.getTotal(),voList);
    }

    @Override
    public List<ProjectAgentVO> listAll(Long projectId) {
        // ⚠️ 不信任前端传的 userId, 从 JWT 解析当前登录用户
        Long userId = BaseContext.getCurrentUserId();
        // Mapper 已 JOIN sys_agent 带出 name/role, 直接返回 VO
        return projectAgentMapper.listAll(projectId, userId);
    }

    @Override
    public void create(ProjectAgentDTO dto) {
        ProjectAgent entity = new ProjectAgent();
        BeanUtils.copyProperties(dto, entity);
        LocalDateTime now = LocalDateTime.now();
        entity.setCreateTime(now);
        entity.setUpdateTime(now);
        // ⚠️ 不信任前端传的 userId, 从 JWT 解析当前登录用户
        entity.setUserId(BaseContext.getCurrentUserId());
        // 加入项目默认参与
        if (entity.getStatus() == null) {
            entity.setStatus(1);
        }
        projectAgentMapper.insert(entity);
    }

    @Override
    public void update(Long id, ProjectAgentDTO dto) {
        // 1. 存在 + 所有权校验（项目 Agent 按用户隔离, 只能改自己的）
        ProjectAgentVO existing = projectAgentMapper.getById(id);
        if (existing == null) {
            throw new BaseException("项目 Agent 不存在: " + id);
        }
        if (!existing.getUserId().equals(BaseContext.getCurrentUserId())) {
            throw new BaseException("无权修改他人的项目 Agent");
        }
        // 2. 更新（userId 不允许改, 覆盖为原值）
        ProjectAgent entity = new ProjectAgent();
        BeanUtils.copyProperties(dto, entity);
        entity.setId(id);
        entity.setUserId(existing.getUserId());
        entity.setUpdateTime(LocalDateTime.now());
        projectAgentMapper.updateById(entity);
    }

    @Override
    public ProjectAgentVO getById(Long id) {
        // 存在 + 所有权校验（项目 Agent 按用户隔离, 只能读自己的）—— 防 IDOR 越权读取
        ProjectAgentVO existing = projectAgentMapper.getById(id);
        if (existing == null) {
            throw new BaseException("项目 Agent 不存在: " + id);
        }
        if (!existing.getUserId().equals(BaseContext.getCurrentUserId())) {
            throw new BaseException("无权查看他人的项目 Agent");
        }
        return existing;
    }

    @Override
    public void deleteByIds(String ids) {
        // 格式: "projectId-id1-id2-id3" —— projectId 仅作过滤, userId 从 JWT 取(防删别人的)
        String[] parts = ids.split("-");
        Long projectId = Long.parseLong(parts[0]);
        Long userId = BaseContext.getCurrentUserId();
        List<Long> idList = new ArrayList<>();
        for (int i = 1; i < parts.length; i++) {
            idList.add(Long.parseLong(parts[i]));
        }
        LocalDateTime now = LocalDateTime.now();
        // 1. 删除项目成员行
        projectAgentMapper.deleteByIds(idList, projectId, userId, now);
        // 2. 级联删除这些成员的项目节点（子查询限定 projectId+userId 防越权）
        projectAgentNodeMapper.deleteByMemberIds(projectId, idList, userId, now);
    }

    /**
     * 从 Agent 池拉取到项目团队（成员行存 agentId 引用池, 节点复制一份进项目）
     * 一个事务：查池 → 逐条插入成员行 + 复制节点 → 全成或全败
     * 单例角色（项目经理/架构师）：项目缺则自动补模板；用户再拉同角色则拒绝
     */
    @Override
    @Transactional
    public int copyFromPool(ProjectAgentCopyDTO dto) {
        if (dto.getAgentIds() == null || dto.getAgentIds().isEmpty()) {
            return 0;
        }
        // ⚠️ 不信任前端传的 userId, 从 JWT 解析当前登录用户
        Long currentUserId = BaseContext.getCurrentUserId();
        LocalDateTime now = LocalDateTime.now();

        // 0. 单例角色自动补：确保项目有且仅有一个 项目经理 / 架构师（模板池 Agent + 节点 + 边）
        autoEnsureSingleton(dto.getProjectId(), "项目经理", currentUserId, now);
        autoEnsureSingleton(dto.getProjectId(), "架构师", currentUserId, now);

        // 1. 池里的 Agent 只允许拉取自己的（防拿别人的池模板）
        List<AgentPool> pool = agentPoolMapper.selectByIds(dto.getAgentIds()).stream()
                .filter(p -> p.getUserId().equals(currentUserId))
                .collect(Collectors.toList());
        // 2. 单例校验：用户拉的经理/架构师，项目已有同角色 → 拒绝
        for (AgentPool p : pool) {
            if (AgentTemplate.SINGLETON_ROLES.contains(p.getRole())
                    && projectAgentMapper.countByRole(dto.getProjectId(), p.getRole()) > 0) {
                throw new BaseException("项目已有一个「" + p.getRole() + "」，一个项目只能有一个");
            }
        }
        // 3. 批量查池节点, 按 agentId 分组, 供逐成员复制
        List<AgentNode> poolNodes = agentNodeMapper.selectByAgentIds(dto.getAgentIds());
        Map<Long, List<AgentNode>> nodesByAgent = poolNodes.stream()
                .collect(Collectors.groupingBy(AgentNode::getAgentId));
        int count = 0;
        for (AgentPool p : pool) {
            insertProjectMember(dto.getProjectId(), currentUserId, p.getId(), now);
            count++;
            // 复制池节点到项目节点表（复制非引用: 项目内修改不影响池；含新 4 技术列）
            copyNodesToProject(dto.getProjectId(), p.getId(), currentUserId, now,
                    nodesByAgent.getOrDefault(p.getId(), Collections.emptyList()));
        }
        return count;
    }

    /** 自动补单例角色：项目缺经理/架构师 → 池里找模板 Agent（没有则创建并插模板节点+边）→ 拉进项目 */
    private void autoEnsureSingleton(Long projectId, String role, Long userId, LocalDateTime now) {
        if (projectAgentMapper.countByRole(projectId, role) > 0) return;
        AgentPool poolAgent = agentPoolMapper.findByRoleAndUser(role, userId);
        if (poolAgent == null) {
            poolAgent = new AgentPool();
            poolAgent.setUserId(userId);
            poolAgent.setName(role);
            poolAgent.setRole(role);
            poolAgent.setStatus(1);
            poolAgent.setCreateTime(now);
            poolAgent.setUpdateTime(now);
            agentPoolMapper.insert(poolAgent);
            insertTemplateNodes(poolAgent.getId(), role, now);   // 模板节点 + 边
        }
        insertProjectMember(projectId, userId, poolAgent.getId(), now);
        copyNodesToProject(projectId, poolAgent.getId(), userId, now,
                agentNodeMapper.selectByAgentIds(Collections.singletonList(poolAgent.getId())));
        System.out.println("[ProjectAgent] 自动补项目单例角色：" + role);
    }

    /** 模板角色池 Agent：插入节点 + 边（AgentTemplate 数据，prompt 预填） */
    private void insertTemplateNodes(Long agentId, String role, LocalDateTime now) {
        for (AgentTemplate.NodeTpl t : AgentTemplate.ROLE_NODE_TEMPLATES.getOrDefault(role, List.of())) {
            AgentNode node = new AgentNode();
            node.setAgentId(agentId);
            node.setNodeName(t.name());
            node.setDescription("");
            node.setSystemPrompt(t.prompt());
            node.setTemperature(0.3);
            node.setTools(null);
            node.setModel(AgentTemplate.MODEL_JSON);
            node.setNodeType(t.nodeType());
            node.setSchemaKey(blankToNull(t.schemaKey()));
            node.setCodeKey(blankToNull(t.codeKey()));
            node.setOutput(blankToNull(t.output()));
            node.setCreateTime(now);
            node.setUpdateTime(now);
            agentNodeMapper.insert(node);
        }
        for (AgentTemplate.EdgeTpl e : AgentTemplate.ROLE_EDGE_TEMPLATES.getOrDefault(role, List.of())) {
            AgentEdge edge = new AgentEdge();
            edge.setAgentId(agentId);
            edge.setFromNode(e.from());
            edge.setType(e.type());
            edge.setToNodes(e.to());
            edge.setCreateTime(now);
            edge.setUpdateTime(now);
            agentEdgeMapper.insert(edge);
        }
    }

    private void insertProjectMember(Long projectId, Long userId, Long agentId, LocalDateTime now) {
        ProjectAgent member = new ProjectAgent();
        member.setProjectId(projectId);
        member.setUserId(userId);
        member.setAgentId(agentId);
        // 拉取进项目默认参与
        member.setStatus(1);
        member.setCreateTime(now);
        member.setUpdateTime(now);
        projectAgentMapper.insert(member);
    }

    /** 复制池节点到项目节点表（复制非引用：项目内修改不影响池；含新 4 技术列） */
    private void copyNodesToProject(Long projectId, Long agentId, Long userId, LocalDateTime now, List<AgentNode> poolNodes) {
        for (AgentNode n : poolNodes) {
            ProjectAgentNode pn = new ProjectAgentNode();
            pn.setProjectId(projectId);
            pn.setAgentId(agentId);
            pn.setUserId(userId);
            pn.setNodeName(n.getNodeName());
            pn.setDescription(n.getDescription());
            pn.setSystemPrompt(n.getSystemPrompt());
            pn.setTemperature(n.getTemperature());
            pn.setTools(n.getTools());
            pn.setModel(n.getModel());
            pn.setNodeType(n.getNodeType());
            pn.setSchemaKey(n.getSchemaKey());
            pn.setCodeKey(n.getCodeKey());
            pn.setOutput(n.getOutput());
            pn.setCreateTime(now);
            pn.setUpdateTime(now);
            projectAgentNodeMapper.insert(pn);
        }
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s;
    }

    private ProjectAgentVO toVO(ProjectAgent projectAgent) {
        ProjectAgentVO vo = new ProjectAgentVO();
        BeanUtils.copyProperties(projectAgent,vo);
        return vo;
    }
}
