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
import com.hina.crewforge.pojo.QueryParam.AgentPoolQueryParam;
import com.hina.crewforge.pojo.dto.AgentPoolDTO;
import com.hina.crewforge.pojo.entity.AgentEdge;
import com.hina.crewforge.pojo.entity.AgentNode;
import com.hina.crewforge.pojo.entity.AgentPool;
import com.hina.crewforge.pojo.entity.ProjectAgent;
import com.hina.crewforge.pojo.entity.ProjectAgentNode;
import com.hina.crewforge.pojo.vo.AgentPoolVO;
import com.hina.crewforge.service.AgentPoolService;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.*;
import java.util.stream.Collectors;

@Service
public class AgentPoolServiceImpl implements AgentPoolService {

    @Autowired
    private AgentPoolMapper agentMapper;

    @Autowired
    private AgentNodeMapper agentNodeMapper;

    @Autowired
    private AgentEdgeMapper agentEdgeMapper;


    @Override
    public PageResult<AgentPoolVO> page(AgentPoolQueryParam agentQueryParam) {
        // ⚠️ 不信任前端传的 userId, 从 JWT 解析当前登录用户
        agentQueryParam.setUserId(BaseContext.getCurrentUserId());
        PageHelper.startPage(agentQueryParam.getPage(),agentQueryParam.getPageSize());

        List<AgentPool> list = agentMapper.list(agentQueryParam);
        Page<AgentPool> p = (Page<AgentPool>)list;

        List<AgentPoolVO> voList = p.getResult().stream().map(this::toVO).collect(Collectors.toList());

        return new PageResult<>(p.getTotal(),voList);
    }

    @Override
    @Transactional
    public Long create(AgentPoolDTO dto) {
        AgentPool entity = new AgentPool();
        BeanUtils.copyProperties(dto, entity);
        LocalDateTime now = LocalDateTime.now();
        entity.setCreateTime(now);
        entity.setUpdateTime(now);
        // ⚠️ 不信任前端传的 userId, 从 JWT 解析当前登录用户
        entity.setUserId(BaseContext.getCurrentUserId());
        // 新增默认启用
        if (entity.getStatus() == null) {
            entity.setStatus(1);
        }
        agentMapper.insert(entity);
        // 按角色生成默认空白节点（模板预置：结构归模板，用户只填提示词/工具/模型）
        insertDefaultNodes(entity.getId(), dto.getRole(), now);
        // 返回自增主键（新建后前端挂节点需要）
        return entity.getId();
    }

    /**
     * 按角色生成默认节点：
     * - 模板角色（项目经理/架构师，见 AgentTemplate）：结构完整（codeKey/schemaKey/output）+ 预填 prompt + 默认边
     * - 其他角色：空白 llm 节点（可编辑字段留空待填，技术字段系统补齐）
     * 成员从池复制（copyFromPool）时节点/边自动带过去，无需重复生成。
     */
    private void insertDefaultNodes(Long agentId, String role, LocalDateTime now) {
        List<AgentTemplate.NodeTpl> tpls = AgentTemplate.ROLE_NODE_TEMPLATES.get(role);
        if (tpls != null) {
            // —— 模板角色：节点 + 边（运行时注册表 key 对齐 classes） ——
            for (AgentTemplate.NodeTpl t : tpls) {
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
            return;
        }
        // —— 非模板角色：空白 llm 节点（可编辑字段留空，技术字段补齐） ——
        for (String name : defaultNodeNames(role)) {
            AgentNode node = new AgentNode();
            node.setAgentId(agentId);
            node.setNodeName(name);
            node.setDescription("");
            node.setSystemPrompt("");
            node.setTools(null);          // 空工具 = 不配工具
            node.setModel(null);          // 空模型 = 跟随全局
            node.setTemperature(0.7);     // 默认采样温度（DB NOT NULL，必须有值）
            node.setNodeType("llm");
            node.setSchemaKey(null);
            node.setCodeKey(null);
            node.setOutput(name + "_output"); // LangGraph 约束：output 不能与 node_name 重名
            node.setCreateTime(now);
            node.setUpdateTime(now);
            agentNodeMapper.insert(node);
        }
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s;
    }

    /** 角色（职位中文 label）→ 默认节点名（对应类的工作流程阶段）；未知角色给 1 个通用占位 */
    private List<String> defaultNodeNames(String role) {
        if (role == null) return Collections.singletonList("节点1");
        switch (role) {
            case "后端开发": return Arrays.asList("伪代码", "代码实现");
            case "前端开发": return Arrays.asList("页面设计", "代码实现");
            case "测试":     return Collections.singletonList("测试判定");
            case "维护":     return Collections.singletonList("维护收敛");
            case "运维部署": return Collections.singletonList("部署执行");
            case "文档维护": return Collections.singletonList("文档编写");
            default:         return Collections.singletonList("节点1");
        }
    }

    @Override
    public void update(Long id, AgentPoolDTO dto) {
        // 1. 存在 + 所有权校验（池按用户隔离，只能改自己的）
        AgentPool existing = agentMapper.getById(id);
        if (existing == null) {
            throw new BaseException("Agent 不存在: " + id);
        }
        if (!existing.getUserId().equals(BaseContext.getCurrentUserId())) {
            throw new BaseException("无权修改他人的 Agent");
        }
        // 2. 更新（userId 不允许改, 从实体里去不掉则覆盖为原值）
        AgentPool entity = new AgentPool();
        BeanUtils.copyProperties(dto, entity);
        entity.setId(id);
        entity.setUserId(existing.getUserId());
        entity.setUpdateTime(LocalDateTime.now());
        agentMapper.updateById(entity);
    }

    @Override
    public AgentPoolVO getById(Long id) {
        // 存在 + 所有权校验（池按用户隔离, 只能读自己的）
        AgentPool entity = agentMapper.getById(id);
        if (entity == null) {
            throw new BaseException("Agent 不存在: " + id);
        }
        if (!entity.getUserId().equals(BaseContext.getCurrentUserId())) {
            throw new BaseException("无权查看他人的 Agent");
        }
        return toVO(entity);
    }

    @Override
    @Transactional
    public void deleteByIds(String ids) {
        // 格式: "id1-id2-id3"（userId 不拼在路径里了, 从 JWT 取当前登录用户）
        String[] parts = ids.split("-");
        Long userId = BaseContext.getCurrentUserId();
        List<Long> idList = new ArrayList<>();
        for (String part : parts) {
            idList.add(Long.parseLong(part));
        }
        LocalDateTime now = LocalDateTime.now();
        // 1. 删除池 Agent
        agentMapper.deleteByIds(idList, userId, now);
        // 2. 级联删除这些 Agent 的节点配置（按 userId 二次校验防越权）
        agentNodeMapper.deleteByAgentIds(idList, userId, now);
        // 3. 级联删除这些 Agent 的边配置（节点没了, 边不能残留）
        agentEdgeMapper.deleteByAgentIds(idList, userId, now);
    }

    private AgentPoolVO toVO(AgentPool agent) {
        AgentPoolVO vo = new AgentPoolVO();
        BeanUtils.copyProperties(agent,vo);
        return vo;
    }
}
