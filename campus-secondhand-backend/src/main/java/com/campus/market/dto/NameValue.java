package com.campus.market.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * 通用「名称 + 数值」项（饼图 / 分类占比等）
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class NameValue {
    private String name;
    private Long value;
}
