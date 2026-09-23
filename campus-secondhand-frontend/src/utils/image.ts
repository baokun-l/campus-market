/**
 * 图片压缩工具 —— 发布商品前把本地图片压小，再上传换回短路径。
 *
 * ★ 为什么从「压成 base64 直接落库」改成「压缩 + 上传」★
 *
 * 旧方案的思路是：本项目没有文件服务器，那就把图片编成 data URL 塞进商品字段
 * （返回 base64 字符串随商品 JSON 落库）。问题出在**列宽**：
 *   - `t_goods.cover` 是 varchar(255)
 *   - `t_goods.images` 是 text（上限 64KB）
 * 而 1200px / JPEG 0.82 压出来的 base64 仍有 100~400KB，
 * MySQL 插入时直接抛 `Data too long for column 'cover'`，
 * 被全局兜底成「服务器内部错误，请稍后再试」——
 * 表现就是**不选图能发布，一选图必然失败**（已用探针实测复现）。
 *
 * 现在的链路：
 *   选图 → 压缩成 JPEG（最长边 1200）→ POST /upload/image → 拿到 /uploads/... 短路径
 * 数据库只存路径，图片走静态资源：可被浏览器缓存、商品列表也不必再搬运几百 KB 的 base64。
 *
 * 压缩依然保留，原因是**上传体积**：一张 1000 万像素的手机原图有 3~8MB，
 * 先压到 1200px 再传，既快又不至于撞上后端 5MB 的单文件上限。
 */

/** 压缩后的自动上传尺寸与质量（与旧 base64 方案保持同一口径，观感不变） */
const DEFAULT_MAX_DIM = 1200
const DEFAULT_QUALITY = 0.82

/**
 * 把一个本地图片文件压缩成 JPEG 的 {@link File}，可直接交给上传接口。
 *
 * @param file   用户选择的原始文件
 * @param maxDim 最长边上限（等比缩放，小图不放大）
 * @param quality JPEG 质量 0~1
 */
export function compressImageToFile(
  file: File,
  maxDim = DEFAULT_MAX_DIM,
  quality = DEFAULT_QUALITY
): Promise<File> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('不是图片文件'))
      return
    }
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('解析图片失败'))
      img.onload = () => {
        // 等比缩到最长边 ≤ maxDim（小图不放大）
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          reject(new Error('无法创建画布'))
          return
        }
        // PNG 透明底在 JPEG 下会变黑，先铺白底
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, w, h)
        ctx.drawImage(img, 0, 0, w, h)
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error('图片压缩失败'))
              return
            }
            /*
             * 统一改成 .jpg 后缀：canvas 输出的是 JPEG，
             * 若沿用原名（如 photo.png）交给后端，扩展名与实际内容不符，
             * 后端按扩展名白名单校验时可能放行一个内容对不上的文件。
             */
            const name = file.name.replace(/\.[^.]+$/, '') + '.jpg'
            resolve(new File([blob], name, { type: 'image/jpeg' }))
          },
          'image/jpeg',
          quality
        )
      }
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  })
}
