package com.campus.market.service;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.campus.market.common.BusinessCode;
import com.campus.market.common.BusinessException;
import com.campus.market.entity.Goods;
import com.campus.market.mapper.AuditLogMapper;
import com.campus.market.mapper.CategoryMapper;
import com.campus.market.mapper.CommentMapper;
import com.campus.market.mapper.FavoriteMapper;
import com.campus.market.mapper.GoodsMapper;
import com.campus.market.mapper.HistoryMapper;
import com.campus.market.mapper.ReviewMapper;
import com.campus.market.mapper.UserMapper;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * ★ L8 的回归测试：归属校验（{@code requireOwner}）不能有「传 null 就放行」的后门 ★
 * <p>
 * <b>守的是什么</b>：{@code updateGoodsStatus} / {@code deleteGoods} 原先带一个
 * 「系统内部语义」的重载，它把 {@code operatorId} 与 {@code role} 一起传 null，
 * 而 {@code requireOwner} 里写着 {@code if (operatorId == null) return;} ——
 * 于是「拿不到操作者身份」＝「放行」。
 * <p>
 * 复核后发现这条旁路在生产代码里<b>零调用者</b>：全仓 4 个调用点全部传了
 * non-null 的 {@code currentUserId(request)}；注释里说的「系统内部联动（如审核通过时改状态）」
 * 走的是 {@code GoodsAuditService} 里直接下发的 {@code goodsMapper.update(...)}，压根不经过本类。
 * 也就是说安全性完全押在一条注释约定上，运行时没有任何东西保证它。
 * <p>
 * <b>为什么这不是杞人忧天</b>：{@code currentUserId()} 是裸强转
 * {@code (Long) request.getAttribute(AuthInterceptor.ATTR_USER_ID)}。一旦拦截器改了属性名、
 * 或将来有人把这两个接口放进公开白名单，拿到的就是 null —— 那一刻
 * 「任何人删任何人的商品 / 下架任何人的在售商品」会**静默成立**，
 * 而现成的探针全是带 token 跑的，照旧全绿。这类「只在异常路径上出现的越权」正是最该钉住的。
 * <p>
 * <b>判据</b>：① 传 null 必须抛 403，且<b>绝不能真的删库</b>；
 * ② 传别人 id 必须抛 403；③ 卖家本人与后台角色照旧放行（别把闸门焊死）；
 * ④ 结构上必须不存在那两个「只能用来传 null」的重载 —— 后门被重新加回来 = 测试红。
 */
class GoodsOwnershipGuardTest {

    private static final long GOODS_ID = 21L;
    private static final long SELLER = 5L;
    private static final long OTHER_USER = 9L;

    private GoodsMapper goodsMapper;
    private GoodsService service;

    @BeforeEach
    void setUp() {
        goodsMapper = mock(GoodsMapper.class);
        service = new GoodsService(
                goodsMapper,
                mock(CategoryMapper.class),
                mock(AuditLogMapper.class),
                mock(UserMapper.class),
                mock(FavoriteMapper.class),
                mock(HistoryMapper.class),
                mock(CommentMapper.class),
                mock(ReviewMapper.class),
                mock(ActivityService.class),
                mock(AnalyticsService.class));

        // updateGoodsStatus 走 LambdaUpdateWrapper<Goods>：列名解析依赖实体元数据，
        // 纯单测没有 MyBatis 启动流程，手动注册一次
        TableInfoHelper.initTableInfo(
                new MapperBuilderAssistant(new MybatisConfiguration(), ""), Goods.class);
    }

    private void givenOnSaleGoods() {
        Goods g = new Goods();
        g.setId(GOODS_ID);
        g.setSellerId(SELLER);
        g.setTitle("二手教材");
        g.setStatus("on_sale");
        when(goodsMapper.selectById(GOODS_ID)).thenReturn(g);
    }

    private BusinessException expectForbidden(Runnable action) {
        BusinessException ex = assertThrows(BusinessException.class, action::run);
        return ex;
    }

    // ==================== ① 失败关闭 ====================

    @Nested
    @DisplayName("operatorId == null 必须失败关闭")
    class FailClosedWhenOperatorUnknown {

        @Test
        @DisplayName("★ 改状态：operatorId 为 null → 403，且不落库")
        void updateStatusRejectsNullOperator() {
            givenOnSaleGoods();

            BusinessException ex = expectForbidden(
                    () -> service.updateGoodsStatus(GOODS_ID, "off_shelf", null, null));

            assertEquals(BusinessCode.FORBIDDEN, ex.getCode(),
                    "认不出操作者应是 403（鉴权问题），不是 1001/404。实际：" + ex.getCode());
            assertNotNull(ex.getMessage());
            assertTrue(ex.getMessage().contains("身份"),
                    "提示要说清是「身份」问题，实际：" + ex.getMessage());
            // ★ 关键：拒绝必须发生在写库之前，不能「先改了再报错」
            verify(goodsMapper, never()).update(any(), any());
        }

        @Test
        @DisplayName("★ 删商品：operatorId 为 null → 403，且绝不真删")
        void deleteRejectsNullOperator() {
            givenOnSaleGoods();

            BusinessException ex = expectForbidden(
                    () -> service.deleteGoods(GOODS_ID, null, null));

            assertEquals(BusinessCode.FORBIDDEN, ex.getCode());
            // 这条是本次修复的**核心断言**：旧实现传 null 会一路走到 deleteById，
            // 「任何人都能删任何人的商品」就是这么来的。
            verify(goodsMapper, never()).deleteById(any(Long.class));
        }
    }

    // ==================== ② 越权（原本就防住了，别在重构中丢掉） ====================

    @Nested
    @DisplayName("非本人且非后台角色：403")
    class WrongOwnerIsForbidden {

        @Test
        @DisplayName("改别人的商品状态 → 403")
        void otherUserCannotChangeStatus() {
            givenOnSaleGoods();

            BusinessException ex = expectForbidden(
                    () -> service.updateGoodsStatus(GOODS_ID, "off_shelf", OTHER_USER, null));

            assertEquals(BusinessCode.FORBIDDEN, ex.getCode());
            assertTrue(ex.getMessage().contains("自己发布的商品"), "实际：" + ex.getMessage());
            verify(goodsMapper, never()).update(any(), any());
        }

        @Test
        @DisplayName("删别人的商品 → 403，且不真删")
        void otherUserCannotDelete() {
            givenOnSaleGoods();

            expectForbidden(() -> service.deleteGoods(GOODS_ID, OTHER_USER, null));

            verify(goodsMapper, never()).deleteById(any(Long.class));
        }
    }

    // ==================== ③ 正常路径不能被误伤 ====================

    @Nested
    @DisplayName("正常路径照旧放行（别把闸门焊死）")
    class LegitOperatorsStillPass {

        @Test
        @DisplayName("卖家本人改自己的商品状态 → 放行并落库")
        void ownerCanChangeStatus() {
            givenOnSaleGoods();

            service.updateGoodsStatus(GOODS_ID, "off_shelf", SELLER, null);

            verify(goodsMapper).update(any(), any());
        }

        @Test
        @DisplayName("卖家本人删自己的商品 → 放行并真删")
        void ownerCanDelete() {
            givenOnSaleGoods();

            service.deleteGoods(GOODS_ID, SELLER, null);

            verify(goodsMapper).deleteById(GOODS_ID);
        }

        @Test
        @DisplayName("后台角色（goods_admin）可操作任意商品 → 放行")
        void adminRolePassesOnAnyGoods() {
            givenOnSaleGoods();

            service.updateGoodsStatus(GOODS_ID, "off_shelf", null, "goods_admin");

            verify(goodsMapper).update(any(), any());
        }

        @Test
        @DisplayName("商品不存在 → 404（不是 403：先分清「不存在」与「不是你的」）")
        void missingGoodsIsNotFound() {
            when(goodsMapper.selectById(GOODS_ID)).thenReturn(null);

            BusinessException ex = expectForbidden(
                    () -> service.updateGoodsStatus(GOODS_ID, "off_shelf", SELLER, null));

            assertEquals(BusinessCode.NOT_FOUND, ex.getCode());
        }
    }

    // ==================== ④ 结构：后门重载不许被加回来 ====================

    @Nested
    @DisplayName("结构约束：只保留显式带 operatorId 的入口")
    class NoNullPassingOverload {

        @Test
        @DisplayName("★ 不存在 updateGoodsStatus(Long,String) / deleteGoods(Long) 这两个「只能传 null」的重载")
        void nullPassingOverloadsMustStayRemoved() {
            List<String> present = new ArrayList<>();
            for (Method m : GoodsService.class.getDeclaredMethods()) {
                if (!Modifier.isPublic(m.getModifiers())) continue;
                if (!m.getName().equals("updateGoodsStatus") && !m.getName().equals("deleteGoods")) continue;
                present.add(m.getName() + "(" + joinTypes(m) + ")");
            }

            assertTrue(present.contains("updateGoodsStatus(Long,String,Long,String)"),
                    "唯一入口丢了？现有重载：" + present);
            assertTrue(present.contains("deleteGoods(Long,Long,String)"),
                    "唯一入口丢了？现有重载：" + present);

            assertTrue(!present.contains("updateGoodsStatus(Long,String)"),
                    "updateGoodsStatus(Long,String) 又回来了 —— 它只能用来绕过归属校验。"
                            + "现有重载：" + present);
            assertTrue(!present.contains("deleteGoods(Long)"),
                    "deleteGoods(Long) 又回来了 —— 它只能用来绕过归属校验。"
                            + "现有重载：" + present);
        }

        private static String joinTypes(Method m) {
            StringBuilder sb = new StringBuilder();
            for (Class<?> t : m.getParameterTypes()) {
                if (sb.length() > 0) sb.append(',');
                sb.append(t.getSimpleName());
            }
            return sb.toString();
        }
    }
}
