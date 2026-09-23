/**
 * 图片上传 API
 * <p>
 * 商品图不再以 base64 随商品 JSON 落库（会撑爆 varchar(255) / text 列宽），
 * 改为「先上传拿短路径，再提交商品」。
 */
import { request } from './request'
import { mockHelpers } from './mock'

const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true'

/**
 * 上传单张商品图，返回可直接写进 `cover` / `images` 的短路径。
 *
 * ★ 返回值为什么**不带 `/api` 前缀** ★
 *
 * 后端返回的是 `/uploads/2026/09/xxxx.jpg` 这样的纯资源路径，
 * 不把部署环境（context-path）写进数据库 —— 否则将来把后端挂到别的路径下，
 * 历史数据里的图片地址会集体失效。
 * 前端这边由 Vite 代理把 `/uploads/**` 转发到后端的 `/api/uploads/**`
 * （见 vite.config.ts），所以渲染层不需要做任何前缀拼接：
 * `<img src="/uploads/...">` 直接可用。
 *
 * @param file 已经压缩过的图片文件（见 {@link compressImageToFile}）
 */
export async function uploadImage(file: File): Promise<string> {
  if (USE_MOCK) {
    await mockHelpers.delay(300)
    // mock 模式没有后端可落盘，用对象 URL 充当「上传结果」。
    // mock 数据本身也只活在当前会话的内存里，两者生命周期一致。
    return URL.createObjectURL(file)
  }

  const form = new FormData()
  form.append('file', file)

  const res = await request<{ url: string }>({
    url: '/upload/image',
    method: 'POST',
    data: form,
    /*
     * ★ 必须显式声明 multipart/form-data ★
     *
     * 请求实例的默认头是 application/json。axios 见到 FormData 配上 JSON 头，
     * 会把表单序列化成 JSON 字符串发出去，后端收到的是「请求体格式不正确」。
     * 显式声明后，axios 在浏览器环境会把 Content-Type 交给浏览器设置，
     * 由浏览器补上带 boundary 的完整 multipart 头。
     */
    headers: { 'Content-Type': 'multipart/form-data' },
    // 多张图连续上传时不闪全屏遮罩、不逐张弹错误；
    // 由调用方（发布页）汇总成一条提示，说明是哪张图失败了。
    showLoading: false,
    silent: true
  })
  return res.url
}
