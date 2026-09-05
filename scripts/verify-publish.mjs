// 발행 후 검증. **부분 발행은 조용하다** — 각 패키지는 올라갔는데 서로를 가리키는
// 버전이 없어서 소비자만 ETARGET 을 본다. 발행할 때마다 이걸 돌린다.
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PKGS = ['protocol', 'collectors', 'relay-guard'];
let bad = 0;

for (const p of PKGS) {
  const name = `@nostr-paywall/${p}`;
  const v = execSync(`npm view ${name} version`, { encoding: 'utf8' }).trim();
  const deps = JSON.parse(
    execSync(`npm view ${name}@${v} dependencies --json`, { encoding: 'utf8' }) || '{}',
  );
  const missing = [];
  for (const [dep, range] of Object.entries(deps)) {
    if (!dep.startsWith('@nostr-paywall/')) continue;
    try {
      execSync(`npm view ${dep}@${range} version`, { stdio: 'pipe' });
    } catch {
      missing.push(`${dep}@${range}`);
    }
  }
  const ok = missing.length === 0;
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗'} ${name}@${v}${ok ? '' : '  → 없는 의존성: ' + missing.join(', ')}`);
}

// 진짜 소비자 경로로 한 번 더. 위 검사가 놓치는 전이 문제까지 잡힌다.
const dir = mkdtempSync(join(tmpdir(), 'paywall-verify-'));
try {
  writeFileSync(join(dir, 'package.json'), '{"name":"verify","private":true}');
  execSync('npm i --silent @nostr-paywall/relay-guard', { cwd: dir, stdio: 'pipe' });
  console.log('✓ 클린룸 설치 성공');
} catch (e) {
  bad++;
  console.log('✗ 클린룸 설치 실패:', String(e.stderr ?? e).split('\n').find((l) => l.includes('error')) ?? e.message);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.exit(bad === 0 ? 0 : 1);
