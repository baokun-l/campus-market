package com.campus.market.service;

import com.campus.market.security.AuthSnapshotCache;
import com.campus.market.security.LoginAttemptGuard;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.conditions.AbstractWrapper;
import com.baomidou.mybatisplus.core.conditions.Wrapper;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.campus.market.common.BusinessCode;
import com.campus.market.common.BusinessException;
import com.campus.market.config.JwtConfig;
import com.campus.market.entity.Comment;
import com.campus.market.entity.Goods;
import com.campus.market.entity.Review;
import com.campus.market.entity.User;
import com.campus.market.mapper.AddressMapper;
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
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.dao.DuplicateKeyException;

import java.math.BigDecimal;
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
 * ★ M5（注册校验半开）+ L4（删商品不清留言/评价）的回归测试 ★
 * <p>
 * <b>M5 守的是什么</b>：注册入口只调了 {@code Validators.required(password, 100, …)} ——
 * 它只判「非空 + 不超列宽」，于是 <b>1 位口令也能注册成功</b>；
 * 而 {@code changePassword} 白纸黑字要求 ≥ 6 位。两条入口口径不一致 →
 * 用户能注册出一个「永远改不成密码」的账号。
 * 另一条：并发重名靠 {@code t_user.username UNIQUE} 兜住了数据完整性，
 * 但抛出来的 {@code DuplicateKeyException} 是 <b>500「服务器内部错误」</b>，
 * 而这明明是再正常不过的「名字被抢注了」。
 * <p>
 * <b>L4 守的是什么</b>：商品删除原先只连带清了收藏与足迹，
 * {@code t_comment} / {@code t_review} 里的行会挂着已经不存在的主键 ——
 * 个人中心点进去 404，按 goods_id 查还会串号。
 * <p>
 * <b>判别式</b>：错误码必须是 {@code 1001}（业务规则拒绝）而不是 500；
 * 连带删除必须真的对 comment / review 两表下发 WHERE goods_id 条件。
 */
class RegisterAndDeleteCascadeTest {

    private static final long GOODS_ID = 21L;
    private static final long SELLER = 5L;

    private UserMapper userMapper;
    private GoodsMapper goodsMapper;
    private CommentMapper commentMapper;
    private ReviewMapper reviewMapper;
    private UserService userService;
    private GoodsService goodsService;

    @BeforeEach
    void setUp() {
        userMapper = mock(UserMapper.class);
        goodsMapper = mock(GoodsMapper.class);
        commentMapper = mock(CommentMapper.class);
        reviewMapper = mock(ReviewMapper.class);

        userService = new UserService(
                userMapper,
                mock(GoodsMapper.class),
                mock(FavoriteMapper.class),
                mock(HistoryMapper.class),
                mock(AddressMapper.class),
                mock(AuditLogMapper.class),
                mock(MessageService.class),
                mock(JwtConfig.class),

                mock(LoginAttemptGuard.class),
                // P1-11：鉴权快照缓存。用 mock —— 本文件断言的是级联删除，不涉及缓存行为
                mock(AuthSnapshotCache.class));

        goodsService = new GoodsService(
                goodsMapper,
                mock(CategoryMapper.class),
                mock(AuditLogMapper.class),
                mock(UserMapper.class),
                mock(FavoriteMapper.class),
                mock(HistoryMapper.class),
                commentMapper,
                reviewMapper,
                mock(ActivityService.class),
                mock(AnalyticsService.class));

        // 连带删除走 LambdaQueryWrapper<Comment/Review>：列名解析依赖实体元数据，
        // 纯单测没有 MyBatis 启动流程，手动注册一次
        TableInfoHelper.initTableInfo(
                new MapperBuilderAssistant(new MybatisConfiguration(), ""), Comment.class);
        TableInfoHelper.initTableInfo(
                new MapperBuilderAssistant(new MybatisConfiguration(), ""), Review.class);
    }

    private BusinessException registerFails(String username, String password, String nickname) {
        BusinessException ex = assertThrows(BusinessException.class,
                () -> userService.register(username, password, nickname));
        return ex;
    }

    // ==================== M5 · 注册口令下限 ====================

    @Test
    @DisplayName("注册 1 位口令必须被拒，且错误码是 1001 而不是 500")
    void registerRejectsTooShortPassword() {
        BusinessException ex = registerFails("zhangsan", "a", "张三");
        assertEquals(BusinessCode.PARAM_ERROR, ex.getCode(), "应是业务规则拒绝（1001）");
        assertNotNull(ex.getMessage());
        assertTrue(ex.getMessage().contains("6"), "提示要说明下限，实际：" + ex.getMessage());
        // 校验没过就不该碰库
        verify(userMapper, never()).insert(any(User.class));
    }

    @Test
    @DisplayName("注册 5 位口令仍被拒（边界：恰好差一位）")
    void registerRejectsFiveCharPassword() {
        assertEquals(BusinessCode.PARAM_ERROR,
                registerFails("zhangsan", "12345", "张三").getCode());
    }

    @Test
    @DisplayName("注册 6 位口令通过（边界：恰好达标）")
    void registerAcceptsSixCharPassword() {
        when(userMapper.selectByUsername("zhangsan")).thenReturn(null);
        userService.register("zhangsan", "123456", "张三");
        verify(userMapper).insert(any(User.class));
    }

    // ==================== M5 · 注册用户名口径（与前端 Register.vue 的 rules 对齐） ====================

    @Test
    @DisplayName("用户名短于 4 位被拒")
    void registerRejectsTooShortUsername() {
        assertEquals(BusinessCode.PARAM_ERROR,
                registerFails("abc", "123456", "张三").getCode());
    }

    @Test
    @DisplayName("用户名含空格/符号被拒（前端 pattern ^[a-zA-Z0-9_]+$）")
    void registerRejectsUsernameWithBadFormat() {
        assertEquals(BusinessCode.PARAM_ERROR,
                registerFails("zhang san!", "123456", "张三").getCode());
        assertEquals(BusinessCode.PARAM_ERROR,
                registerFails("张三", "123456", "张三").getCode());
    }

    // ==================== M5 · 并发重名：唯一键冲突要翻译成 1001 ====================

    @Test
    @DisplayName("★ 并发重名：预检没查到、insert 撞唯一索引 → 1001「已被占用」而不是 500")
    void registerMapsDuplicateKeyToFriendlyError() {
        // 预检通过（模拟「两个请求同时查到不存在」的竞态窗口）
        when(userMapper.selectByUsername("zhangsan")).thenReturn(null);
        // 但 insert 时对方已经先写入，唯一索引把这次挡下
        when(userMapper.insert(any(User.class)))
                .thenThrow(new DuplicateKeyException("Duplicate entry 'zhangsan' for key 'username'"));

        BusinessException ex = registerFails("zhangsan", "123456", "张三");

        assertEquals(BusinessCode.PARAM_ERROR, ex.getCode(),
                "唯一键冲突必须翻译成 1001，不能让它变成 500");
        assertTrue(ex.getMessage().contains("已被占用"),
                "文案要与预检路径一致，实际：" + ex.getMessage());
    }

    // ==================== L4 · 删商品连带清留言 / 评价 ====================

    private void givenGoods() {
        Goods g = new Goods();
        g.setId(GOODS_ID);
        g.setSellerId(SELLER);
        g.setTitle("二手教材");
        g.setPrice(new BigDecimal("20.00"));
        when(goodsMapper.selectById(GOODS_ID)).thenReturn(g);
    }

    private static String whereOf(Wrapper<?> wrapper) {
        return ((AbstractWrapper<?, ?, ?>) wrapper).getSqlSegment();
    }

    @Test
    @DisplayName("单条删除：留言与评价都要按 goods_id 连带清掉")
    void deleteGoodsClearsCommentsAndReviews() {
        givenGoods();

        // ★ L8（2026-09-22）：原来是 deleteGoods(GOODS_ID, null, null) ★
        // 传 null 走的是 requireOwner 的「静默放行」旁路（该旁路已删除，现在传 null 直接 403）。
        // 改成传真实卖家 id：既照样覆盖连带清理，又顺带把**生产路径的归属校验**也跑了一遍 ——
        // 用后门调用来测生产逻辑，测的就不是生产逻辑。
        goodsService.deleteGoods(GOODS_ID, SELLER, null);

        ArgumentCaptor<Wrapper<Comment>> commentCap = ArgumentCaptor.forClass(Wrapper.class);
        verify(commentMapper).delete(commentCap.capture());
        assertTrue(whereOf(commentCap.getValue()).contains("goods_id"),
                "留言删除必须限定 goods_id，实际 WHERE = " + whereOf(commentCap.getValue()));

        ArgumentCaptor<Wrapper<Review>> reviewCap = ArgumentCaptor.forClass(Wrapper.class);
        verify(reviewMapper).delete(reviewCap.capture());
        assertTrue(whereOf(reviewCap.getValue()).contains("goods_id"),
                "评价删除必须限定 goods_id，实际 WHERE = " + whereOf(reviewCap.getValue()));
    }

    @Test
    @DisplayName("★ 批量删除通道同样要连带清 —— 单条通道改了、批量通道漏了是老毛病")
    void batchDeleteGoodsClearsCommentsAndReviews() {
        Goods g = new Goods();
        g.setId(GOODS_ID);
        g.setTitle("二手教材");
        when(goodsMapper.selectBatchIds(any())).thenReturn(List.of(g));

        goodsService.batchDeleteGoods(List.of(GOODS_ID));

        ArgumentCaptor<Wrapper<Comment>> commentCap = ArgumentCaptor.forClass(Wrapper.class);
        verify(commentMapper).delete(commentCap.capture());
        assertTrue(whereOf(commentCap.getValue()).contains("goods_id"));

        ArgumentCaptor<Wrapper<Review>> reviewCap = ArgumentCaptor.forClass(Wrapper.class);
        verify(reviewMapper).delete(reviewCap.capture());
        assertTrue(whereOf(reviewCap.getValue()).contains("goods_id"));
    }
}
