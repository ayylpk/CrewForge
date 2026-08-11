package com.hina.crewforge.controller;

import com.hina.crewforge.common.result.PageResult;
import com.hina.crewforge.common.result.Result;
import com.hina.crewforge.pojo.QueryParam.TenantQueryParam;
import com.hina.crewforge.pojo.dto.TenantDTO;
import com.hina.crewforge.pojo.vo.MemberVO;
import com.hina.crewforge.pojo.vo.TenantApplyVO;
import com.hina.crewforge.pojo.vo.TenantVO;
import com.hina.crewforge.service.TenantService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@Tag(name = "Tenant")
@RestController
@RequestMapping("/api/tenant")
@RequiredArgsConstructor
@Slf4j
public class TenantController {

    private final TenantService tenantService;

    @Operation(summary = "分页查询")
    @GetMapping
    public Result<PageResult<TenantVO>> page(TenantQueryParam tenantQueryParam) {
        log.info("分页查询团队:{}",tenantQueryParam);
        PageResult<TenantVO> pageResult = tenantService.page(tenantQueryParam);
        return Result.success(pageResult);
    }

    @Operation(summary = "新增")
    @PostMapping
    public Result<Long> create(@RequestBody TenantDTO dto) {
        log.info("新增团队:{}", dto);
        Long id = tenantService.create(dto);
        return Result.success(id);
    }

    @Operation(summary = "删除")
    @DeleteMapping("/{id}")
    public Result<Void> delete(@PathVariable Long id) {
        log.info("删除团队 id = {}", id);
        tenantService.deleteById(id);
        return Result.success();
    }

    @Operation(summary = "修改")
    @PutMapping("/{id}")
    public Result<Void> update(@PathVariable Long id, @RequestBody TenantDTO dto) {
        log.info("修改id = {}的团队为:{}", id, dto);
        tenantService.update(id, dto);
        return Result.success();
    }

    @Operation(summary = "查询单个")
    @GetMapping("/{id}")
    public Result<TenantVO> getById(@PathVariable Long id) {
        TenantVO vo = tenantService.getById(id);
        return Result.success(vo);
    }

    @Operation(summary = "申请加入团队(凭邀请码)")
    @PostMapping("/apply/{code}")
    public Result<Void> apply(@PathVariable String code){
        log.info("申请加入团队 invitationCode = {}", code);
        tenantService.apply(code);
        return Result.success();
    }

    @Operation(summary = "查看团队申请列表(管理员审核用)")
    @GetMapping("/apply/list")
    public Result<List<TenantApplyVO>> applyList(@RequestParam Long tenantId) {
        log.info("查看团队申请列表 tenantId = {}", tenantId);
        return Result.success(tenantService.listApply(tenantId));
    }

    @Operation(summary = "同意申请(申请人正式加入团队)")
    @PutMapping("/apply/approve/{id}")
    public Result<Void> approve(@PathVariable Long id) {
        log.info("同意申请 applyId = {}", id);
        tenantService.approve(id);
        return Result.success();
    }

    @Operation(summary = "拒绝申请")
    @PutMapping("/apply/reject/{id}")
    public Result<Void> reject(@PathVariable Long id) {
        log.info("拒绝申请 applyId = {}", id);
        tenantService.reject(id);
        return Result.success();
    }

    @Operation(summary = "团队成员列表(仅团队成员可查看)")
    @GetMapping("/members")
    public Result<List<MemberVO>> members(@RequestParam Long tenantId) {
        log.info("团队成员列表 tenantId = {}", tenantId);
        return Result.success(tenantService.listMembers(tenantId));
    }

}
