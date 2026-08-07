package com.hina.crewforge.pojo.dto;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class ProjectFileDTO {
    private Long projectId;
    private String filePath;
    private String fileContent;
    private String fileType;
}
