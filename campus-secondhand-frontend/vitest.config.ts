/**
 * Vitest 单元测试配置
 *
 * 测试环境：happy-dom（轻量 DOM 实现，比 jsdom 快 2~3 倍）
 * 测试数据：全部来源于 src/api/mock.ts 中的 JSON 静态数据，无需后端
 */
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

export default defineConfig({
  plugins: [
    vue(),
    AutoImport({
      imports: ['vue', 'vue-router', 'pinia'],
      resolvers: [ElementPlusResolver()],
      dts: false
    }),
    Components({
      resolvers: [ElementPlusResolver()],
      dts: false
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
        api: 'modern-compiler'
      }
    }
  },
  /*
   * ============================================================================
   * ★ 关于「文件级并行会静默丢文件」—— 不要顺手把这里的默认值改掉 ★
   * ============================================================================
   * `fileParallelism` 保持默认（开启）。本机沙箱下它偶尔会丢掉 1~2 个 spec 文件，
   * 而且**退出码仍然是 0**：跑到 28 个文件、丢掉 3 个、报告全绿，
   * 100 多条用例根本没执行。详见 scripts/check-test-coverage.mjs 的头部注释。
   *
   * 为什么不干脆关掉并行：
   *   关掉后全套要跑 243 秒，开着只要 55 秒。为一个只在特定沙箱环境出现的问题
   *   去惩罚所有正常环境（含 CI），代价与收益不成比例。而且它丢的文件每次都不一样、
   *   单独跑都过 —— 说明问题在环境的 worker 机制，不在测试本身。
   *
   * 那「测过关」这件事怎么变得可信：
   *   `npm run test:audit` = 串行跑 + 产出 JSON 报告 + 逐个核对文件数，
   *   磁盘上有几个 spec 就必须跑几个，少一个直接判失败（退出码 1）。
   *   **需要对外引用测试数字时，只引用 `test:audit` 的结果。**
   *   `npm test` 屏幕上那行 `Tests N passed` 在本机是不可信的，别抄。
   */
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['src/**/*.spec.ts'],
    setupFiles: ['./src/test/setup.ts'],
    reporters: ['verbose'],
    server: {
      deps: {
        // Element Plus 组件按需引入时会带上 theme-chalk 的 .css 导入，
        // 必须内联交给 Vite 处理，否则 Node ESM 会报 Unknown file extension ".css"
        inline: ['element-plus']
      }
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      // 关闭自动清理：本机沙箱会拦截目录删除操作，改为生成前手动清理
      clean: false,
      include: ['src/utils/**', 'src/api/**', 'src/stores/**', 'src/components/**'],
      exclude: ['src/**/*.spec.ts', 'src/test/**']
    }
  }
})
