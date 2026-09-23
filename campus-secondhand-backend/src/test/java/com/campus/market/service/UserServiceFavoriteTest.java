package com.campus.market.service;

import com.campus.market.common.BusinessCode;
import com.campus.market.common.BusinessException;
import com.campus.market.entity.Favorite;
import com.campus.market.entity.Goods;
import com.campus.market.mapper.AddressMapper;
import com.campus.market.mapper.AuditLogMapper;
import com.campus.market.mapper.FavoriteMapper;
import com.campus.market.mapper.GoodsMapper;
import com.campus.market.mapper.HistoryMapper;
import com.campus.market.mapper.UserMapper;
import com.campus.market.security.AuthSnapshotCache;
import com.campus.market.security.LoginAttemptGuard;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DuplicateKeyException;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 收藏切换的「连点 / 并发」安全性测试。
 * <p>
 * ★ 守的是「收藏按钮连点两下不能变 500」★
 * <p>
 * t_favorite 上有唯一键 uk_user_goods(user_id, goods_id)。原实现是 check-then-act：
 * 先 selectOne 判断有没有收藏过，再 insert —— 前端连点两下会让两个请求同时判出
 * 「未收藏」并双双 insert，后到的撞唯一键抛 DuplicateKeyException，
 * 一路冒到全局兜底分支，用户看到 500「系统内部错误」。
 * <p>
 * 修复后：保留原本的 `selectOne` + 按主键 `deleteById` / `insert` 结构
 * （这个结构本身不会死锁），只把插入时的唯一键冲突**认下来** ——
 * 能撞唯一键就说明「已收藏」这个目标状态已被并发请求达成，对本次调用而言是成功。
 * <p>
 * ⚠️ 同时钉死一个反面教材：**不要**把实现改成「先用 WHERE 删、再插入」。
 * REPEATABLE READ 下 `DELETE ... WHERE user_id=? AND goods_id=?` 对不存在的行会加**间隙锁**，
 * 并发事务各持间隙锁又都要拿插入意向锁 → 成环死锁，MySQL 抛
 * `Deadlock found when trying to get lock`，结果同样是 500（实测：0,0,500,500,0,0,500,0）。
 * 本文件把这套语义钉死，防止有人改回 check-then-act 或改成 WHERE 删。
 */
class UserServiceFavoriteTest {

    private static final long USER_ID = 7L;
    private static final long GOODS_ID = 1L;

    private GoodsMapper goodsMapper;
    private FavoriteMapper favoriteMapper;
    private UserService service;

    @BeforeEach
    void setUp() {
        goodsMapper = mock(GoodsMapper.class);
        favoriteMapper = mock(FavoriteMapper.class);
        service = new UserService(
                mock(UserMapper.class),
                goodsMapper,
                favoriteMapper,
                mock(HistoryMapper.class),
                mock(AddressMapper.class),
                mock(AuditLogMapper.class),
                mock(MessageService.class),
                mock(com.campus.market.config.JwtConfig.class),

                mock(LoginAttemptGuard.class),
                // P1-11：鉴权快照缓存。用 mock —— 本文件断言的是收藏查询，不涉及缓存行为
                mock(AuthSnapshotCache.class));

        Goods g = new Goods();
        g.setId(GOODS_ID);
        when(goodsMapper.selectById(GOODS_ID)).thenReturn(g);
        // refreshFavoriteCount 会重新数一遍真实收藏行数，默认 0 行即可
        when(favoriteMapper.selectCount(any())).thenReturn(0L);
    }

    @Test
    @DisplayName("★ 并发撞唯一键：插入抛 DuplicateKeyException 时不算失败，返回「已收藏」而不是 500")
    void duplicateInsertIsTreatedAsAlreadyFavorited() {
        // selectOne 判出「未收藏」（并发下两个请求都会判出未收藏）
        when(favoriteMapper.selectOne(any())).thenReturn(null);
        // 随后被并发请求抢先插入 → 本次 insert 撞唯一键
        when(favoriteMapper.insert(any(Favorite.class)))
                .thenThrow(new DuplicateKeyException("Duplicate entry '7-1' for key 'uk_user_goods'"));

        boolean favorited = assertDoesNotThrow(() -> service.toggleFavorite(USER_ID, GOODS_ID),
                "连点收藏撞唯一键不应冒泡成异常（否则全局兜底会回 500）");

        assertTrue(favorited, "另一请求已把状态写成「已收藏」，本次调用应返回 true");
    }

    @Test
    @DisplayName("取消收藏：按主键删掉既有行，返回 false，且不再插入")
    void existingRowIsDeletedByPrimaryKey() {
        Favorite exist = new Favorite();
        exist.setId(99L);
        when(favoriteMapper.selectOne(any())).thenReturn(exist);

        assertFalse(service.toggleFavorite(USER_ID, GOODS_ID));

        verify(favoriteMapper).deleteById(99L);
        verify(favoriteMapper, never()).insert(any(Favorite.class));
    }

    @Test
    @DisplayName("★ 不许改成「先用 WHERE 删」：那是实测会触发 InnoDB 死锁的写法")
    void neverUsesWhereBasedDelete() {
        when(favoriteMapper.selectOne(any())).thenReturn(null);

        service.toggleFavorite(USER_ID, GOODS_ID);

        /*
         * REPEATABLE READ 下 `DELETE ... WHERE user_id=? AND goods_id=?` 命中不到行时，
         * 会对 uk_user_goods 的唯一索引**间隙加锁**；N 个并发事务各持间隙锁、
         * 又都要拿插入意向锁去 INSERT 同一行 → 互相等待成环，
         * MySQL 挑 victim 回滚并抛 `Deadlock found when trying to get lock` → 同样是 500。
         * 实测把实现改成 WHERE 删之后，8 次并发的结果是 0,0,500,500,0,0,500,0。
         * 因此这里把「不使用 Wrapper 删除」钉死：取消收藏只走按主键的 deleteById。
         */
        verify(favoriteMapper, never()).delete(any());
    }

    @Test
    @DisplayName("首次收藏：查无既有行 → 正常插入并返回 true")
    void firstTimeFavoriteInserts() {
        when(favoriteMapper.selectOne(any())).thenReturn(null);

        assertTrue(service.toggleFavorite(USER_ID, GOODS_ID));

        verify(favoriteMapper).insert(any(Favorite.class));
    }

    @Test
    @DisplayName("商品不存在仍然回 1002（不能因为改成先删就把前置校验弄丢）")
    void missingGoodsIsNotFound() {
        when(goodsMapper.selectById(GOODS_ID)).thenReturn(null);

        assertEquals(BusinessCode.NOT_FOUND,
                assertThrows(BusinessException.class,
                        () -> service.toggleFavorite(USER_ID, GOODS_ID)).getCode());
    }

    @Test
    @DisplayName("计数回写走「重数真实行数」的单列 UPDATE，不整体回写商品行")
    void refreshFavoritesUsesSingleColumnUpdate() {
        when(favoriteMapper.selectOne(any())).thenReturn(null);
        when(favoriteMapper.selectCount(any())).thenReturn(3L);

        service.toggleFavorite(USER_ID, GOODS_ID);

        // 只发一条 UPDATE（.set 单列），且以 goodsId 为条件；不是 updateById 整体回写
        verify(goodsMapper).update(eq(null), any());
        verify(goodsMapper, never()).updateById(any());
    }
}
