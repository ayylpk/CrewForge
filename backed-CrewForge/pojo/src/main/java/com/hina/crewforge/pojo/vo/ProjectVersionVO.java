package com.hina.crewforge.pojo.vo;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import java.time.LocalDateTime;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class ProjectVersionVO {
    private Long id;
    private Long projectId;
    private String version;
    private String snapshot;
    private String changeLog;
    private String triggerBy;
    private LocalDateTime createTime;
}
