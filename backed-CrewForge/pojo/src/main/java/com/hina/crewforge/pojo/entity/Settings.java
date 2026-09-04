package com.hina.crewforge.pojo.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 运行时设置 (sys_settings) —— cc-switch 式单行表，恒为一行 id=1（阶段 2 点火卡）
 *
 * 口径（v2 F1 拍板）：只放运行时项；DB 连接参数在 .env，不在此表（引擎先连库才能读表——自举约束）。
 * 消费方：引擎直接读表（settings.ts，30s 缓存，sys_settings > .env > 内置）；
 *         本表 Java 侧只做 CRUD + 掩码回显 + 测试连接。
 * api_key 空 = 引擎沿用 .env 的 DEEPSEEK_API_KEY。时间列交给 DB ON UPDATE 维护。
 */
@Data
@TableName("sys_settings")
public class Settings {

    /** 单行配置，恒为 1 */
    @TableId(type = IdType.INPUT)
    private Integer id;
    /** 模型名（设置页一旦填写=全局覆盖所有角色内置模型名；按角色分档是 v3 T3） */
    private String modelName;
    /** openai 兼容端点 baseURL（modelKind=openai 必填；deepseek 留空=官方） */
    private String modelUrl;
    /** 端点密钥（HTTP 层只进不出：回显一律掩码） */
    private String apiKey;
    /** openai | deepseek */
    private String modelKind;
    /** 引擎回调 Java 基址（A7：替换 Node.ts 写死 localhost:8080） */
    private String javaBaseUrl;
    /** 确认门无应答自动放行分钟数（阶段 3 消费） */
    private Integer confirmTimeoutMin;
    /** 1=冒烟追加 build（阶段 4 消费，默认关保演示稳定） */
    private Integer smokeBuild;
    private LocalDateTime updateTime;
}
