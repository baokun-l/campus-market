/**
 * 一次性打印数据库基线（探针跑完后的收尾复核用）。
 *
 * 存在的理由：这些查询以前是用 `node -e "..."` 现场拼的，
 * 里面同时有反引号模板串、双引号 SQL、单引号字面量 —— 层数一多必然被 shell 提前截断，
 * 表现是「命令 exit 1 且一行输出都没有」，排查时间全花在引号上。
 * 落成文件后参数是死的，不会随调用方式漂移。
 */
import { execSync } from 'node:child_process';

const MYSQL = String.raw`C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe`;

function sql(q) {
  const cmd = `"${MYSQL}" -uroot -p123456 --default-character-set=utf8mb4 -N -B -Dcampus_market -e "${q}"`;
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const show = (label, q) => console.log(label.padEnd(26) + sql(q).replace(/\n/g, '  '));

/* ★ 为什么 al 不给固定基线 ★
 * 2026-09-22 实测踩到：标题里写死的 `al=26` 与实际 33 对不上，
 * 第一反应是"基线被破坏了" —— 但逐条查下来，那 7 条全在 18:14–20:49（**历史轮次**），
 * 其中两条名字直接叫「L10探针活动A/B」；本轮（>=21:00）新增 **0** 条。
 * 根因：t_audit_log 是 **append-only** 表，任何正常业务操作（管理员审核、退款…）都会让它增长
 * ⇒ **用固定数字当基线，本身就是必然误报的判据**（"台账撒谎"的又一形态）。
 * 正确做法：不看总数，看「今日新增的明细里有没有探针痕迹」。
 */
console.log('=== 表计数（基线 u=6 g=16 o=9 ol=40 ac=4；al 是 append-only，见下一段）===');
show('t_user', 'SELECT COUNT(*) FROM t_user');
show('t_goods', 'SELECT COUNT(*) FROM t_goods');
show('t_order', 'SELECT COUNT(*) FROM t_order');
show('t_order_log', 'SELECT COUNT(*) FROM t_order_log');
show('t_activity', 'SELECT COUNT(*) FROM t_activity');

console.log('=== 审计日志（★ 不看总数，只看"今日新增"里有没有探针痕迹）===');
show('t_audit_log 总数', 'SELECT COUNT(*) FROM t_audit_log');
show('今日新增条数', 'SELECT COUNT(*) FROM t_audit_log WHERE DATE(create_time)=CURDATE()');
{
  const rows = sql("SELECT CONCAT(id, '  ', create_time, '  ', action, '  ', IFNULL(target, '-'), '  by ', IFNULL(operator, '-')) FROM t_audit_log WHERE DATE(create_time)=CURDATE() ORDER BY id DESC LIMIT 20");
  console.log('--- 今日新增明细（倒序，最多 20 条）---');
  console.log(rows ? rows.split('\n').map((l) => '  ' + l).join('\n') : '  （今日无新增）');
}

console.log('=== 商品状态分布（基线 off_shelf:1 on_sale:13 pending:1 sold:1）===');
show('t_goods status', "SELECT CONCAT(status, ':', COUNT(*)) FROM t_goods GROUP BY status ORDER BY status");
show('#12 status (勿动)', 'SELECT status FROM t_goods WHERE id=12');

console.log('=== 系统设置 ===');
show('auto_offline_days', 'SELECT auto_offline_days FROM t_settings LIMIT 1');
show('max_publish_per_day', 'SELECT max_publish_per_day FROM t_settings LIMIT 1');

console.log('=== 探针残留（应全为 0）===');
show('goods id>=9000', 'SELECT COUNT(*) FROM t_goods WHERE id >= 9000');
show('goods.auto_offline logs', "SELECT COUNT(*) FROM t_audit_log WHERE action='goods.auto_offline'");
show('t_goods auto_increment', "SELECT AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA='campus_market' AND TABLE_NAME='t_goods'");
