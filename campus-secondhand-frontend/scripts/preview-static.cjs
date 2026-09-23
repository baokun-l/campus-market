/**
 * 给 dist/ 起一个支持 SPA fallback 的静态服务器
 * 默认监听 127.0.0.1:7788
 */
const http = require('http')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '../dist')
const PORT = Number(process.env.PORT) || 7788
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json'
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0])
  let file = path.join(ROOT, url === '/' ? 'index.html' : url)
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return }
  fs.stat(file, (err, stat) => {
    if (err || stat.isDirectory()) {
      // SPA fallback
      file = path.join(ROOT, 'index.html')
    }
    fs.readFile(file, (err2, buf) => {
      if (err2) { res.writeHead(404); res.end('not found'); return }
      const ext = path.extname(file).toLowerCase()
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' })
      res.end(buf)
    })
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`preview server: http://127.0.0.1:${PORT}/`)
})
