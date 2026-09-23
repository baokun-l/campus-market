package com.campus.market.service;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.campus.market.common.BusinessCode;
import com.campus.market.common.BusinessException;
import com.campus.market.entity.Goods;
import com.campus.market.entity.Order;
import com.campus.market.mapper.AuditLogMapper;
import com.campus.market.mapper.GoodsMapper;
import com.campus.market.mapper.OrderLogMapper;
import com.campus.market.mapper.OrderMapper;
import com.campus.market.mapper.UserMapper;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 订单取消 / 退款与库存回补测试。
 * <p>
 * ★ 守的是「交易作废，库存必须回来」★
 * <p>
 * 下单是原子扣库存（防超卖），取消 / 退款却原先不回补 —— 一次「下了又取消」
 * 就永久吃掉一件库存，售罄置 sold 的商品再也回不到在售。
 * 回补同样必须由数据库原子完成（先读后写会在并发下单时把别人刚扣走的覆盖回去），
 * 这里的断言落在「调用了原子 update」与「sold 正确翻回 on_sale」上。
 */
class OrderServiceCancelTest {

    private static final String ORDER_ID = "2026091700001";
    private static final long BUYER = 4L;
    private static final long SELLER = 5L;
    private static final long GOODS_ID = 7L;

    private OrderMapper orderMapper;
    private GoodsMapper goodsMapper;
    private OrderService service;

    @BeforeEach
    void setUp() {
        orderMapper = mock(OrderMapper.class);
        goodsMapper = mock(GoodsMapper.class);
        service = new OrderService(
                orderMapper,
                goodsMapper,
                mock(OrderLogMapper.class),
                mock(UserMapper.class),
                mock(AuditLogMapper.class),
                mock(ActivityService.class));
        // restoreStock 用 LambdaUpdateWrapper<Goods>：set() 解析列名需要实体元数据，
        // 纯单测没有 MyBatis 启动流程，手动注册一次（等价于容器扫描实体的那一步）
        TableInfoHelper.initTableInfo(
                new MapperBuilderAssistant(new MybatisConfiguration(), ""), Goods.class);
    }

    private Order givenOrder(String status) {
        Order o = new Order();
        o.setId(ORDER_ID);
        o.setBuyerId(BUYER);
        o.setSellerId(SELLER);
        o.setStatus(status);
        o.setGoodsId(GOODS_ID);
        o.setQuantity(2);
        o.setAmount(new java.math.BigDecimal("50"));
        when(orderMapper.selectById(ORDER_ID)).thenReturn(o);
        return o;
    }

    private Goods givenGoods(int stock, String status) {
        Goods g = new Goods();
        g.setId(GOODS_ID);
        g.setStock(stock);
        g.setStatus(status);
        when(goodsMapper.selectById(GOODS_ID)).thenReturn(g);
        return g;
    }

    @Test
    @DisplayName("买家取消待付款订单：状态置 cancelled，库存原子回补")
    void buyerCancelRestoresStock() {
        givenOrder("pending_payment");
        givenGoods(3, "on_sale");

        assertDoesNotThrow(() -> service.cancelByBuyer(ORDER_ID, BUYER, "拍错了"));

        ArgumentCaptor<Order> captor = ArgumentCaptor.forClass(Order.class);
        verify(orderMapper).updateById(captor.capture());
        assertEquals("cancelled", captor.getValue().getStatus());
        assertEquals("拍错了", captor.getValue().getCancelReasonText());
        // 回补走数据库原子 update（stock = COALESCE(stock,0) + qty），不能是先读后写
        verify(goodsMapper).update(any(), any());
    }

    @Test
    @DisplayName("售罄商品回补后翻回在售 —— 库存回来了却还挂着已售出，等于白回补")
    void soldGoodsFlipsBackToOnSale() {
        givenOrder("pending_payment");
        // 第一次读（回补前）stock=0 且 sold；回补后重读应拿到新库存
        Goods before = givenGoods(0, "sold");
        Goods after = new Goods();
        after.setId(GOODS_ID);
        after.setStock(2);
        after.setStatus("sold");
        when(goodsMapper.selectById(GOODS_ID)).thenReturn(before, after);

        service.cancelByBuyer(ORDER_ID, BUYER, null);

        /*
         * ★ 翻回 on_sale 也必须走「单列原子 UPDATE」，不能 updateById 整实体回写 ★
         * 早先这里确实是 `latest.setStatus("on_sale"); updateById(latest)` ——
         * 而 latest 是一次**快照**：读它之后若有人刚把这件商品买走（库存又变 0），
         * 整行回写会把读到的旧库存盖回去，等于把别人刚扣掉的库存还了回来（超卖）。
         * 现在一次取消会发两条单列 UPDATE：① stock 回补；② sold → on_sale。
         */
        verify(goodsMapper, times(2)).update(any(), any());
        verify(goodsMapper, never()).updateById(any(Goods.class));
    }

    @Test
    @DisplayName("在售（未售罄）商品回补时不多手改状态")
    void onSaleGoodsKeepsStatus() {
        givenOrder("pending_payment");
        givenGoods(3, "on_sale");

        service.cancelByBuyer(ORDER_ID, BUYER, null);

        verify(goodsMapper, never()).updateById(any(Goods.class));
    }

    @Test
    @DisplayName("只有买家本人能取消，且仅限待付款 —— 已付款要走退款线")
    void onlyBuyerCancelPendingPayment() {
        givenOrder("pending_payment");
        assertEquals(BusinessCode.FORBIDDEN,
                assertThrows(BusinessException.class,
                        () -> service.cancelByBuyer(ORDER_ID, SELLER, null)).getCode());

        givenOrder("pending_ship");
        assertEquals(BusinessCode.PARAM_ERROR,
                assertThrows(BusinessException.class,
                        () -> service.cancelByBuyer(ORDER_ID, BUYER, null)).getCode());
    }

    @Test
    @DisplayName("管理员关闭订单同样回补库存")
    void adminCloseRestoresStock() {
        givenOrder("pending_ship");
        givenGoods(1, "on_sale");

        service.updateOrderStatus(ORDER_ID, "cancelled", null, null, "管理员关闭");

        verify(goodsMapper).update(any(), any());
    }

    @Test
    @DisplayName("管理员退款后库存回补，订单关闭")
    void refundRestoresStock() {
        givenOrder("pending_ship");
        givenGoods(0, "sold");

        service.refundOrder(ORDER_ID, null, "协商一致", null);

        ArgumentCaptor<Order> captor = ArgumentCaptor.forClass(Order.class);
        verify(orderMapper).updateById(captor.capture());
        assertEquals("cancelled", captor.getValue().getStatus());
        verify(goodsMapper).update(any(), any());
    }

    @Test
    @DisplayName("非取消流转（发货）不碰库存 —— 回补只属于交易作废")
    void shipDoesNotTouchStock() {
        givenOrder("pending_ship");
        givenGoods(1, "on_sale");

        service.updateOrderStatus(ORDER_ID, "shipped", "SF12345678", "顺丰速运", null);

        verify(goodsMapper, never()).update(any(), any());
    }
}
