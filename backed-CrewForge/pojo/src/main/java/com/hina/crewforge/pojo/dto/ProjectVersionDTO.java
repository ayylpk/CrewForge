package com.hina.crewforge.pojo.dto;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class ProjectVersionDTO {
    private Long projectId;
    private String version;
    private String snapshot;
    private String changeLog;
    private String triggerBy;
}
