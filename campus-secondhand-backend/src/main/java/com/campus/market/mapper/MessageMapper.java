package com.campus.market.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.campus.market.entity.Message;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.util.List;
import java.util.Map;

/**
 * 私信数据访问层
 */
@Mapper
public interface MessageMapper extends BaseMapper<Message> {
    /** 会话列表（我参与的会话，按最后消息时间倒序） */
    List<Map<String, Object>> selectSessions(@Param("userId") Long userId);

    /** 某会话的全部消息 */
    List<Message> selectBySession(@Param("sessionId") String sessionId, @Param("userId") Long userId);

    /** 未读总数 */
    int countUnread(@Param("userId") Long userId);

    /** 标记会话已读 */
    int markRead(@Param("sessionId") String sessionId, @Param("userId") Long userId);
}
