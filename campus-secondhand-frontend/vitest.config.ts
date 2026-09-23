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
