package com.campus.market.controller;

import com.campus.market.common.BusinessException;
import com.campus.market.common.ImageType;
import com.campus.market.common.Result;
import com.campus.market.interceptor.AuthInterceptor;
import com.campus.market.security.UploadQuotaGuard;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * 图片上传接口
 * <p>
 * ★ 这个接口是为了修一个「发布商品必然 500」的缺陷而补的 ★
 * <p>
 * 原先前端 {@code Publish.vue} 把卖家选的图压成 base64 data URL，
 * 直接塞进 {@code cover} / {@code images} 字段提交。而
 * {@code t_goods.cover} 是 {@code varchar(255)}、{@code images} 是 {@code text}（上限 64KB），
 * 压缩后的 base64 仍有 100~400KB —— MySQL 插入时抛
 * {@code Data too long for column 'cover'}，被 {@code GlobalExceptionHandler}
 * 兜底成「服务器内部错误，请稍后再试」。
 * 表现就是：**不选图能发布，一选图就报服务器异常**。
 * <p>
 * 改成「先上传拿 URL、再提交商品」后：
 * <ul>
 *   <li>库里只存 {@code /uploads/2026/09/xxxx.jpg} 这样的短路径，列宽绰绰有余；</li>
 *   <li>图片走静态资源，浏览器可缓存，不必每次列表接口都搬运几百 KB 的 base64；</li>
 *   <li>商品列表 / 详情的响应体积恢复正常。</li>
 * </ul>
 * <p>
 * ★ 与现有审核流程的关系：本接口只负责「把图存下来」，<b>不改变任何商品状态</b>。
 * 上传成功后商品仍是「草稿在浏览器里」的状态，只有调 {@code POST /goods}
 * 才会以 {@code pending} 进入审核队列 —— 审核逻辑一行未动。
 * <p>
 * ★ 权限：上传需要登录（{@code /upload/**} 不在 {@code AuthInterceptor.PUBLIC_GET} 里），
 * 未登录直接 401；但**读取**上传目录是匿名的（{@code GET /uploads/**} 在白名单内），
 * 否则 {@code <img src>} 带不上 token，商品图会全部裂开。
 * <p>
 * ★★ 校验顺序（2026-09-23 补齐 P1-10 后定稿，顺序本身有意义）★★
 * <ol>
 *   <li><b>次数闸门</b>（{@link UploadQuotaGuard}）—— 唯一不读文件内容的检查，必须最先。
 *       放在后面会出现反直觉后果：攻击者用**永远不合法**的文件反复请求时，
 *       每次都在更贵的分支上被拒，闸门却一次都没计数。</li>
 *   <li><b>非空</b> —— 后面所有判断都要用到它。</li>
 *   <li><b>字节上限</b> —— 便宜，且在读内容之前。</li>
 *   <li><b>魔数嗅探</b>（{@link ImageType}）—— 需要读文件头，是最贵的一步，所以最后。</li>
 * </ol>
 * <p>
 * ★★ 关于被删掉的 {@code Content-Type} 前缀校验 ★★
 * <p>
 * 旧实现检查 {@code file.getContentType().startsWith("image/")}。它已被魔数嗅探**取代**，
 * 而不是被放松：{@code Content-Type} 是**客户端自己声明的**（改一个字就能过），
 * 而魔数要绕过就必须真的交出一段以 JPEG/PNG/GIF/WEBP/BMP 签名开头的字节流。
 * 留着它只会多一条「合法图片因客户端声明错误而被误拒」的路径，拦不住任何真实攻击。
 * 同理，原「扩展名白名单」也不再需要单独判：**落盘用的扩展名取自嗅探结果**
 * （一个封闭的 5 元素集合），比白名单更强。
 */
@RestController
public class UploadController {

    private static final Logger log = LoggerFactory.getLogger(UploadController.class);

    /** 落盘目录按年月分片，避免单目录堆几万个文件 */
    private static final DateTimeFormatter DATE_DIR = DateTimeFormatter.ofPattern("yyyy/MM");

    private final UploadQuotaGuard uploadQuotaGuard;

    @Value("${app.upload.dir:uploads}")
    private String uploadDir;

    @Value("${app.upload.max-image-bytes:2097152}")
    private long maxImageBytes;

    @Autowired
    public UploadController(UploadQuotaGuard uploadQuotaGuard) {
        this.uploadQuotaGuard = uploadQuotaGuard;
    }

    /**
     * 测试用构造器：直接指定落盘目录与单图上限。
     * <p>
     * Spring 走上面那个 {@code @Autowired} 构造器，两个存储相关字段由 {@code @Value} 注入；
     * 这个口子只影响「写到哪/多大算大」两个输入，不影响任何生产行为
     * （与 {@code AiQuotaGuard} 的假时钟构造器同一思路：不写用例就等于没验证过）。
     */
    UploadController(UploadQuotaGuard uploadQuotaGuard, String uploadDir, long maxImageBytes) {
        this.uploadQuotaGuard = uploadQuotaGuard;
        this.uploadDir = uploadDir;
        this.maxImageBytes = maxImageBytes;
    }

    /**
     * 上传单张图片
     *
     * @param file 表单字段名固定为 {@code file}（前端 FormData 的 key）
     * @return {@code data.url} 可直接写进商品的 {@code cover} 或 {@code images}
     */
    @PostMapping("/upload/image")
    public Result<Map<String, Object>> uploadImage(@RequestParam("file") MultipartFile file,
                                                   HttpServletRequest request) {
        /*
         * ★ 闸门放第一位 ★：身份只认 token（AuthInterceptor 解析后放在 request 属性里），
         * 请求体里带什么 userId 一律不算数。
         */
        uploadQuotaGuard.acquire(currentUserId(request));

        if (file == null || file.isEmpty()) {
            throw BusinessException.paramError("没有收到文件，请重新选择图片");
        }
        if (file.getSize() > maxImageBytes) {
            throw BusinessException.paramError(
                    "图片太大了，单张不能超过 " + (maxImageBytes / 1024 / 1024) + "MB，请换一张或先压缩");
        }

        ImageType type = sniff(file);
        if (type == null) {
            throw BusinessException.paramError("这不是有效的图片文件，请使用 jpg / png / gif / webp / bmp 格式的图片");
        }

        /*
         * ★ 扩展名取「嗅探结果」，不取客户端给的文件名 ★
         * 名实不符的提交（JPEG 字节存成 .png）在浏览器/截图工具/微信另存里很常见，
         * 按字节定扩展名既避免误拒，也保证「存下来的后缀 = 它真实的格式」。
         */
        String ext = type.ext();

        /*
         * ★ 文件名一律重新生成，绝不沿用客户端传来的名字 ★
         * 原文件名可能带 ../ 做路径穿越（写到 uploads 目录之外），
         * 也可能包含中文/空格/特殊字符，在不同文件系统上出问题。
         * 现在连扩展名都来自字节而不是文件名 —— 客户端提供的名字**一个字符都不进入落盘路径**。
         */
        String datePart = LocalDate.now().format(DATE_DIR);
        String stored = UUID.randomUUID().toString().replace("-", "") + "." + ext;
        Path dir = root().resolve(datePart);

        try {
            Files.createDirectories(dir);
            // transferTo 用绝对路径：相对路径会依赖容器临时目录，换环境就写错地方
            file.transferTo(dir.resolve(stored));
        } catch (IOException | IllegalStateException e) {
            log.error("图片落盘失败 dir={}", dir, e);
            throw BusinessException.of("图片保存失败，请稍后再试");
        }

        String url = "/uploads/" + datePart + "/" + stored;
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("url", url);
        data.put("name", stored);
        data.put("size", file.getSize());
        return Result.success(data);
    }

    /**
     * 读文件头做魔数嗅探。
     * <p>
     * 只读 {@link ImageType#HEAD_LENGTH} 个字节 —— 这里**刻意不用** {@code file.getBytes()}：
     * 那是把整个文件读进堆内存，而单图上限是 2MB，正是「上传接口」最不该做的事
     * （几十个并发就能顶出 OOM）。只读文件头还必须显式关闭流，所以用 try-with-resources。
     *
     * @return 识别出的类型；读不到内容或签名不匹配都返回 {@code null}（调用方一律当拒收）
     */
    private static ImageType sniff(MultipartFile file) {
        byte[] head = new byte[ImageType.HEAD_LENGTH];
        int filled = 0;
        try (InputStream in = file.getInputStream()) {
            int read;
            while (filled < head.length && (read = in.read(head, filled, head.length - filled)) > 0) {
                filled += read;
            }
        } catch (IOException e) {
            log.error("读取上传文件头失败 name={}", file.getOriginalFilename(), e);
            throw BusinessException.of("图片读取失败，请重新选择后再试");
        }
        if (filled <= 0) {
            return null;
        }
        // 不足 12 字节时按实际长度截断，交给 ImageType 自己判边界（它越界返回 false，不抛异常）
        return ImageType.sniff(filled == head.length ? head : Arrays.copyOf(head, filled));
    }

    /** 当前登录用户 id（由 {@code AuthInterceptor} 解析 JWT 并回查数据库后写入） */
    private Long currentUserId(HttpServletRequest request) {
        return (Long) request.getAttribute(AuthInterceptor.ATTR_USER_ID);
    }

    /** 上传根目录的绝对路径 */
    private Path root() {
        return Paths.get(uploadDir).toAbsolutePath().normalize();
    }
}
