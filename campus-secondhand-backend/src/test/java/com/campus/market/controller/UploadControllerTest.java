package com.campus.market.controller;

import com.campus.market.common.BusinessCode;
import com.campus.market.common.BusinessException;
import com.campus.market.interceptor.AuthInterceptor;
import com.campus.market.security.UploadQuotaGuard;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 上传接口测试（P1-10：次数闸门 + 魔数嗅探）。
 * <p>
 * ★ 本类必须直连 controller，不走 MockMvc ★
 * <p>
 * 这里要证明的是「接口**内部**的判定与顺序」，不是 HTTP 层的映射（那是另一个关注点）。
 * 直连可以精确地检查两件 MockMvc 看不见的事：
 * <ol>
 *   <li><b>被拒时磁盘上有没有多出文件</b> —— 校验顺序写错（先落盘再校验）会照样返回错误码，
 *       只有去数文件才能发现；</li>
 *   <li><b>两次失败用的是哪个分支的提示</b> —— 用来判「闸门 vs 魔数」的先后，
 *       这是次序判据，比计时判据可靠。</li>
 * </ol>
 * <p>
 * ★ 落盘目录用 {@code @TempDir}，不碰真实 uploads ★
 */
class UploadControllerTest {

    private static final long MAX_BYTES = 2 * 1024 * 1024L;

    /** 一个真的 JPEG 头（SOI + APP0/JFIF + 尺寸段），足够长的真实样本 */
    private static final byte[] JPEG = hex("FFD8FFE000104A46494600010100000100010000");
    /** 真的 PNG 头（8 字节签名 + IHDR 起始） */
    private static final byte[] PNG = hex("89504E470D0A1A0A0000000D49484452");
    /** 完整的 WEBP 容器头 */
    private static final byte[] WEBP = hex("524946462400000057454250");

    @TempDir
    Path uploadRoot;

    private AtomicLong clock;

    @BeforeEach
    void setUp() {
        clock = new AtomicLong(1_700_000_000_000L);
    }

    private UploadController controller(UploadQuotaGuard guard) {
        return new UploadController(guard, uploadRoot.toString(), MAX_BYTES);
    }

    /** 默认闸门（额度很宽，用于专门测嗅探的用例） */
    private UploadController controllerWith() {
        return controller(new UploadQuotaGuard(1000, 0, 60, clock::get));
    }

    private static MockHttpServletRequest request(long userId) {
        MockHttpServletRequest req = new MockHttpServletRequest();
        req.setAttribute(AuthInterceptor.ATTR_USER_ID, userId);
        return req;
    }

    // ==================== 魔数嗅探 ====================

    @Test
    @DisplayName("★ 落盘扩展名取「字节」而不是文件名：JPEG 字节 + photo.png ⇒ 存成 .jpg")
    void storesExtensionFromBytesNotFromFilename() throws IOException {
        MultipartFile file = new MockMultipartFile("file", "photo.png", "image/png", JPEG);

        Map<String, Object> data = controllerWith().uploadImage(file, request(7L)).getData();

        String url = String.valueOf(data.get("url"));
        assertTrue(url.endsWith(".jpg"),
                "字节是 JPEG，就该按 JPEG 存 —— 客户端把后缀写成 .png 不算数，实际 URL：" + url);
        assertTrue(Files.exists(uploadRoot.resolve(url.replace("/uploads/", ""))),
                "URL 必须对应一个真的落盘文件：" + url);
    }

    @Test
    @DisplayName("★ 内容不是图片时拒收，且**磁盘上不留文件**（校验必须早于落盘）")
    void rejectsNonImageAndWritesNothing() {
        String html = "<!DOCTYPE html><html><script>alert(1)</script></html>";
        // 名字与声明的 Content-Type 都是图片 —— 两个都是客户端可控的，都不该被采信
        MultipartFile file = new MockMultipartFile("file", "evil.png", "image/png",
                html.getBytes(StandardCharsets.UTF_8));

        BusinessException e = assertThrows(BusinessException.class,
                () -> controllerWith().uploadImage(file, request(7L)));
        assertEquals(BusinessCode.PARAM_ERROR, e.getCode());
        assertTrue(e.getMessage().contains("图片"), "应说清「这不是图片」，实际：" + e.getMessage());

        assertEquals(0, countFiles(), "被拒的请求不能在磁盘上留下任何文件（先落盘再校验就会留下）");
    }

    @Test
    @DisplayName("RIFF 容器但不是 WEBP（wav）也拒 —— 防止把非图片的 RIFF 文件存下来")
    void rejectsRiffThatIsNotWebp() {
        MultipartFile file = new MockMultipartFile("file", "sound.png", "image/png",
                hex("524946462400000057415645"));

        assertThrows(BusinessException.class, () -> controllerWith().uploadImage(file, request(7L)));
        assertEquals(0, countFiles());
    }

    @Test
    @DisplayName("短于签名的文件（只有 RIFF 四字节）不抛异常，按拒收处理")
    void tooShortFileIsRejectedNotCrashed() {
        MultipartFile file = new MockMultipartFile("file", "a.png", "image/png", hex("52494646"));

        BusinessException e = assertThrows(BusinessException.class,
                () -> controllerWith().uploadImage(file, request(7L)));
        assertEquals(BusinessCode.PARAM_ERROR, e.getCode());
        assertEquals(0, countFiles());
    }

    @Test
    @DisplayName("WEBP / PNG 也能过，扩展名各自正确")
    void acceptsWebpAndPng() {
        Map<String, Object> w = controllerWith()
                .uploadImage(new MockMultipartFile("file", "a.webp", "image/webp", WEBP), request(7L)).getData();
        Map<String, Object> p = controllerWith()
                .uploadImage(new MockMultipartFile("file", "b.png", "image/png", PNG), request(7L)).getData();

        assertTrue(String.valueOf(w.get("url")).endsWith(".webp"));
        assertTrue(String.valueOf(p.get("url")).endsWith(".png"));
    }

    @Test
    @DisplayName("没有扩展名的文件照样能传（类型由字节决定，名字不参与判定）")
    void acceptsFileWithoutExtension() {
        Map<String, Object> data = controllerWith()
                .uploadImage(new MockMultipartFile("file", "noext", "application/octet-stream", PNG), request(7L))
                .getData();

        assertTrue(String.valueOf(data.get("url")).endsWith(".png"));
    }

    @Test
    @DisplayName("★ 客户端文件名一个字符都不进落盘路径：../../evil.png 也只会存成 UUID")
    void clientFilenameNeverReachesDisk() {
        Map<String, Object> data = controllerWith()
                .uploadImage(new MockMultipartFile("file", "../../../evil.png", "image/png", PNG), request(7L))
                .getData();

        String url = String.valueOf(data.get("url"));
        assertTrue(Pattern.matches("^/uploads/\\d{4}/\\d{2}/[0-9a-f]{32}\\.png$", url),
                "URL 必须是 年月分片 + 32 位 UUID + 嗅探出的扩展名，实际：" + url);
        assertFalse(url.contains("evil"), "文件名不该出现在 URL 里");
        assertTrue(Files.exists(uploadRoot.resolve(url.replace("/uploads/", ""))), "文件必须落在 uploads 根目录之内");
    }

    // ==================== 其它校验 ====================

    @Test
    @DisplayName("空文件 / 超大文件各自给出说得清的提示")
    void rejectsEmptyAndOversize() {
        MultipartFile empty = new MockMultipartFile("file", "a.png", "image/png", new byte[0]);
        BusinessException e1 = assertThrows(BusinessException.class,
                () -> controllerWith().uploadImage(empty, request(7L)));
        assertTrue(e1.getMessage().contains("没有收到文件") || e1.getMessage().contains("重新选择"),
                "实际：" + e1.getMessage());

        byte[] big = new byte[(int) MAX_BYTES + 1];
        System.arraycopy(PNG, 0, big, 0, PNG.length);   // 头部是真的 PNG，确保是被「大小」拒而不是被「魔数」拒
        MultipartFile oversize = new MockMultipartFile("file", "big.png", "image/png", big);
        BusinessException e2 = assertThrows(BusinessException.class,
                () -> controllerWith().uploadImage(oversize, request(7L)));
        assertTrue(e2.getMessage().contains("太大"), "实际：" + e2.getMessage());

        assertEquals(0, countFiles());
    }

    // ==================== 次数闸门 ====================

    @Test
    @DisplayName("★ 闸门真的接在了接口上：额度 1 时第二张被拒，提示里带生效配置")
    void guardIsWiredIntoController() {
        UploadQuotaGuard guard = new UploadQuotaGuard(1, 0, 60, clock::get);
        UploadController c = controller(guard);

        c.uploadImage(new MockMultipartFile("file", "a.png", "image/png", PNG), request(7L));

        BusinessException e = assertThrows(BusinessException.class,
                () -> c.uploadImage(new MockMultipartFile("file", "b.png", "image/png", PNG), request(7L)));
        assertEquals(BusinessCode.PARAM_ERROR, e.getCode());
        assertTrue(e.getMessage().contains("频繁"), "实际：" + e.getMessage());
        // 配置可到达性：窗口与额度都能从响应里看出来
        assertTrue(e.getMessage().contains("60"), "提示里应带生效的窗口秒数，实际：" + e.getMessage());
        assertTrue(e.getMessage().contains("1"), "提示里应带生效的额度，实际：" + e.getMessage());
    }

    @Test
    @DisplayName("★ 闸门排在魔数之前（次序判据）：两次都用坏文件，第二次撞的是闸门而不是魔数")
    void guardRunsBeforeMagicCheck() {
        UploadQuotaGuard guard = new UploadQuotaGuard(1, 0, 60, clock::get);
        UploadController c = controller(guard);
        MultipartFile junk = new MockMultipartFile("file", "x.png", "image/png",
                "not an image at all".getBytes(StandardCharsets.UTF_8));

        BusinessException first = assertThrows(BusinessException.class, () -> c.uploadImage(junk, request(7L)));
        assertTrue(first.getMessage().contains("图片"), "第一次应撞在魔数上，实际：" + first.getMessage());

        /*
         * ★ 这一条就是「次序判据」★
         * 若实现把闸门放在魔数之后，坏文件永远走不到闸门那一行 ⇒ 第二次仍会报「不是图片」，
         * 于是「反复发垃圾请求」可以无限刷，闸门一次都不计数。
         */
        BusinessException second = assertThrows(BusinessException.class, () -> c.uploadImage(junk, request(7L)));
        assertTrue(second.getMessage().contains("频繁"),
                "第二次必须撞在闸门上（说明闸门排在魔数之前），实际：" + second.getMessage());
    }

    @Test
    @DisplayName("闸门按用户隔离：alice 被限流不影响 bob")
    void guardIsPerUser() {
        UploadQuotaGuard guard = new UploadQuotaGuard(1, 0, 60, clock::get);
        UploadController c = controller(guard);

        c.uploadImage(new MockMultipartFile("file", "a.png", "image/png", PNG), request(7L));
        assertThrows(BusinessException.class,
                () -> c.uploadImage(new MockMultipartFile("file", "b.png", "image/png", PNG), request(7L)));

        Map<String, Object> bob = c
                .uploadImage(new MockMultipartFile("file", "c.png", "image/png", PNG), request(8L))
                .getData();
        assertNotNull(bob.get("url"), "bob 应当能正常上传");
    }

    // ==================== 辅助 ====================

    /** 统计落盘目录下的文件总数（递归），用于证明「被拒的请求没留下文件」 */
    private long countFiles() {
        try (Stream<Path> walk = Files.walk(uploadRoot)) {
            return walk.filter(Files::isRegularFile).count();
        } catch (IOException e) {
            throw new IllegalStateException("统计落盘文件失败", e);
        }
    }

    private static byte[] hex(String s) {
        byte[] out = new byte[s.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }
}
