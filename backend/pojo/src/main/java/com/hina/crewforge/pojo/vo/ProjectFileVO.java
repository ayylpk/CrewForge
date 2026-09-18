package com.hina.crewforge.pojo.vo;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import java.time.LocalDateTime;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class ProjectFileVO {
    private Long id;
    private Long projectId;
    private String filePath;
    private String fileContent;
    private String fileType;
    private Integer userModified;
    private LocalDateTime createTime;
    private LocalDateTime updateTime;
}
