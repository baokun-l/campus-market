/**
 * 自证：mvnw.cmd 到底听不听 env.JAVA_HOME？
 * 如果听了，说明 build-release.mjs 里传 env 这一步真的能钉住编译器；
 * 如果不听，那"钉 JDK"就是假的，必须换手段（toolchains / -Dmaven.compiler.executable）。
 *
 * ★ 只用 ASCII 部分做断言 ★：batch 输出走系统 ANSI(GBK)，中文列会乱码，
 *   但 "Java version:" 之后是纯 ASCII 数字，latin1 解码后依然正确。
 */
import { spawnSync } from 'node:child_process';

const BE = 'C:\\Users\\刘宝杰\\Desktop\\软件开发项目实践\\软件开发\\实践任务3：后端开发(前后端分离)\\campus-secondhand-backend';
const JBR = 'D:\\Android\\Android Studio\\jbr';
const JDK17 = 'C:\\Program Files\\Java\\jdk-17';

function run(label, javaHome) {
    const r = spawnSync('mvnw.cmd', ['-v'], {
        cwd: BE,
        env: { ...process.env, JAVA_HOME: javaHome },
        shell: true,
        encoding: 'latin1',
        timeout: 120000
    });
    const out = (r.stdout || '') + (r.stderr || '');
    const m = out.match(/Java version:\s*([\d._]+)/);
    const mvn = out.match(/Apache Maven\s*([\d.]+)/);
    console.log(`\n--- ${label}  JAVA_HOME=${javaHome}`);
    console.log(`    exit=${r.status}  Maven=${mvn ? mvn[1] : '?'}  Java=${m ? m[1] : '?(未解析到)'}`);
    return m ? m[1] : null;
}

const a = run('A. 错误的 JAVA_HOME (Android JBR)', JBR);
const b = run('B. 正确的 JAVA_HOME (jdk-17)', JDK17);

console.log('\n== 判据 ==');
if (!a || !b) {
    console.log('✗ 至少一次没解析到 Java version —— 探针本身失效，不能下结论');
    process.exit(2);
}
if (a === b) {
    console.log(`✗ 两者相同 (${a}) —— mvnw **不**听 env.JAVA_HOME！`);
    console.log('   ⇒ build-release.mjs 里传 env 是无效动作，必须改用 toolchains 或 -Dmaven.compiler.executable');
    process.exit(1);
}
console.log(`✓ 两者不同：JBR=${a}  jdk-17=${b}`);
console.log('   ⇒ env.JAVA_HOME 能控制编译所用 JDK，"钉 JDK"这招是有效的。');
process.exit(0);
