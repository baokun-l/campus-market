import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd())
  return {
    /*
     * ★ 部署到子路径时的资源前缀（部署适配清单 P2-3）★
     *
     * 默认 '/'，与「不写这一行」的行为**完全等价** —— 所以对当前（根域名）部署零影响。
     * 需要挂到 https://host/market/ 时，构建时给 `VITE_BASE=/market/` 即可，
     * 不必改代码，也不必改 nginx 之外的东西。
     *
     * ★ 它必须与路由的 history base 成对 ★
     * 只改这里、不改 src/router/index.ts 的 createWebHistory(...)，
     * 会得到一个「首页能开、点导航就 404」的残缺站点（见那份文件的注释）。
     * 两者现在都从 Vite 注入的同一个 base 取值，改一处两边同时生效。
     */
    base: env.VITE_BASE || '/',
    plugins: [
      vue(),
      AutoImport({
        imports: ['vue', 'vue-router', 'pinia'],
        resolvers: [ElementPlusResolver()],
        dts: 'src/types/auto-imports.d.ts'
      }),
      Components({
        resolvers: [ElementPlusResolver()],
        dts: 'src/types/components.d.ts'
      })
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    css: {
      preprocessorOptions: {
        scss: {
          // 启用 modern API 消除 Dart Sass legacy JS API 警告
          api: 'modern-compiler',
          additionalData: '@use "@/styles/variables.scss" as *;'
        }
      }
    },
    server: {
      port: 5173,
      host: true,
      open: true,
      proxy: {
        // ⚠️ target 必须是「后端服务的源」，不能复用 VITE_API_BASE。
        // VITE_API_BASE 是给 axios 的**相对前缀**（'/api'），拿它当 target 会让
        // http-proxy 收到一个非法 URL，联调时表现为 500 / ECONNREFUSED，
        // 排查起来像是后端没起，实际是代理指错了地方。
        // 后端 server.port=8080 且 context-path=/api，因此前端 /api/xxx
        // 原样转发到 http://localhost:8080/api/xxx，**无需 rewrite**。
        '/api': {
          target: env.VITE_API_PROXY || 'http://localhost:8080',
          changeOrigin: true
        },
        // ★ 商品图片静态资源 ★
        //
        // 数据库里存的是 `/uploads/2026/09/xxxx.jpg` 这样的**不含 context-path**
        // 的短路径（好处：后端将来挂到别的 context-path 下，历史数据不失效）。
        // 但后端 context-path=/api，静态资源映射 `/uploads/**` 的实际地址其实是
        // `http://localhost:8080/api/uploads/**`。
        // 于是 `<img src="/uploads/...">` 必须靠这里补一条代理转发过去，
        // 否则请求打到 Vite 开发服务器自身 → 404，商品列表整片裂图。
        // （生产环境由 nginx 把 `/uploads` 转发到后端 `/api/uploads`，见部署说明。）
        '/uploads': {
          target: env.VITE_API_PROXY || 'http://localhost:8080',
          changeOrigin: true,
          rewrite: (p) => `/api${p}`
        }
      }
    },
    build: {
      target: 'es2018',
      outDir: 'dist',
      assetsDir: 'assets',
      cssCodeSplit: true,
      sourcemap: false,
      rollupOptions: {
        output: {
          // 注意：不要用对象形式 `{ ui: ['element-plus'] }`。
          // 对象形式会让 Rollup 把该包**当作入口**，从而保留它的全部导出，
          // 使 tree-shaking 完全失效（实测 ui chunk 1.06 MB）。
          // 函数形式只做「分组」，不改变模块的存活判定。
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return
            if (id.includes('echarts') || id.includes('zrender')) return 'echarts'
            if (id.includes('element-plus')) return 'ui'
            if (
              id.includes('/vue/') ||
              id.includes('@vue/') ||
              id.includes('vue-router') ||
              id.includes('pinia')
            ) {
              return 'vue'
            }
          }
        }
      },
      chunkSizeWarningLimit: 1500
    }
  }
})
