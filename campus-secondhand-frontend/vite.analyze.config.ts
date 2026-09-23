/**
 * 构建产物体积分析配置（仅用于性能分析，不参与正常运行）
 * 用法：vite build --config vite.analyze.config.ts
 *
 * 通过 moduleParsed 钩子累计每个模块的源码体积，输出 Top 30 大模块，
 * 用于定位「谁把包撑大了」。
 */
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
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
    }),
    {
      name: 'module-size-analyzer',
      apply: 'build',
      generateBundle(_options, bundle) {
        const norm = (id: string) => id.replace(/\\/g, '/')
        // 只分析 JS chunk，取 renderedLength（已 tree-shake + 压缩后的真实贡献）
        const chunks = Object.values(bundle).filter((f: any) => f.type === 'chunk') as any[]

        const total = chunks.reduce((a, c) => a + (c.code?.length ?? 0), 0)

        // ① 每个 chunk 的包构成
        console.log('\n================ 各 chunk 的包构成（renderedLength）================')
        const byPkgAll = new Map<string, number>()
        for (const c of chunks) {
          for (const [id, info] of Object.entries<any>(c.modules ?? {})) {
            const nid = norm(id)
            const m = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(nid)
            const pkg = m ? m[1] : '(项目源码)'
            byPkgAll.set(pkg, (byPkgAll.get(pkg) ?? 0) + (info.renderedLength ?? 0))
          }
        }
        const pkgRows = [...byPkgAll.entries()].sort((a, b) => b[1] - a[1])
        console.log('【全部 JS 合计 ' + (total / 1024).toFixed(1) + ' KB（未 gzip）】')
        pkgRows.slice(0, 15).forEach(([pkg, size]) => {
          const pct = ((size / total) * 100).toFixed(1)
          console.log(
            pkg.padEnd(30),
            (size / 1024).toFixed(1).padStart(9) + ' KB',
            (pct + '%').padStart(8)
          )
        })

        // ② element-plus 到底打进了哪些组件
        const epComponents = new Map<string, number>()
        let epTotal = 0
        for (const c of chunks) {
          for (const [id, info] of Object.entries<any>(c.modules ?? {})) {
            const nid = norm(id)
            if (!nid.includes('element-plus')) continue
            const len = info.renderedLength ?? 0
            epTotal += len
            const m = /element-plus\/es\/components\/([^/]+)\//.exec(nid)
            const key = m ? `组件: ${m[1]}` : 'EP 核心/工具'
            epComponents.set(key, (epComponents.get(key) ?? 0) + len)
          }
        }
        console.log('\n================ element-plus 实际打进产物的模块（合计 ' + (epTotal / 1024).toFixed(1) + ' KB）================')
        const epRows = [...epComponents.entries()].sort((a, b) => b[1] - a[1])
        console.log('分组数: ' + epRows.length)
        epRows.slice(0, 30).forEach(([k, v]) => {
          console.log(k.padEnd(36), (v / 1024).toFixed(1).padStart(9) + ' KB')
        })

        // ③ lodash-es / icons 明细
        const detail = (keyword: string, label: string) => {
          let sum = 0
          const list: Array<[string, number]> = []
          for (const c of chunks) {
            for (const [id, info] of Object.entries<any>(c.modules ?? {})) {
              const nid = norm(id)
              if (!nid.includes(keyword)) continue
              const len = info.renderedLength ?? 0
              sum += len
              list.push([nid.split('node_modules/')[1] || nid, len])
            }
          }
          console.log(`\n---- ${label} 合计 ${(sum / 1024).toFixed(1)} KB（${list.length} 个模块）----`)
          list.sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([n, l]) => {
            console.log('  ' + n.padEnd(56), (l / 1024).toFixed(1).padStart(8) + ' KB')
          })
        }
        detail('lodash-es', 'lodash-es')
        detail('@element-plus/icons-vue', '@element-plus/icons-vue')
        console.log('')
      }
    }
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }
  },
  css: {
    preprocessorOptions: {
      scss: { api: 'modern-compiler', additionalData: '@use "@/styles/variables.scss" as *;' }
    }
  },
  build: {
    target: 'es2018',
    outDir: 'dist-analyze',
    write: false,
    cssCodeSplit: true,
    sourcemap: false
  }
})
