// CJS 산출물 후처리. 두 가지를 한다.
//
// 1) `{"type":"commonjs"}` 를 심는다.
//    패키지 루트가 `"type": "module"` 이라 dist/cjs/*.js 도 ESM 으로 해석된다.
//    중첩 package.json 하나로 그 디렉토리만 CJS 로 되돌린다 — 확장자를 .cjs 로
//    바꾸면 상대 import 경로까지 전부 손봐야 해서 이쪽이 훨씬 싸다.
//
// 2) **낮춰진 동적 import 를 되살린다.**
//    TypeScript 는 CJS 로 내보낼 때 `import(x)` 를
//    `Promise.resolve().then(() => require(x))` 로 바꾼다. cashu-ts 는 ESM 전용이라
//    그 require 는 `SyntaxError: Unexpected token 'export'` 로 죽는다.
//    CJS 파일 안의 진짜 `import()` 는 Node 가 정상 지원하므로 되돌려 놓는다.
//    (소스에서 `new Function('return import(s)')` 트릭을 쓰면 이 문제는 없지만
//     vitest 같은 샌드박스가 모듈을 해석 못 해서 테스트가 깨진다. 후처리가 낫다.)

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const pkgDir = process.argv[2];
if (!pkgDir) throw new Error('사용법: fix-cjs.mjs <packages/name>');

const root = resolve(process.cwd(), '..', '..', pkgDir, 'dist/cjs');
writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');

const DOWNLEVELED = /Promise\.resolve\(\)\.then\(\(\)\s*=>\s*require\((['"][^'"]+['"])\)\)/g;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

let restored = 0;
for (const file of walk(root)) {
  const before = readFileSync(file, 'utf8');
  const after = before.replace(DOWNLEVELED, (_m, spec) => {
    restored++;
    return `import(${spec})`;
  });
  if (after !== before) writeFileSync(file, after);
}

// collectors 는 cashu-ts 를 반드시 동적으로 물어야 한다. 패턴이 안 잡히면
// TypeScript 가 출력 형태를 바꾼 것이므로 조용히 넘기지 말고 빌드를 깨뜨린다.
if (pkgDir.endsWith('collectors') && restored === 0) {
  throw new Error(
    'CJS 출력에서 낮춰진 동적 import 를 못 찾았다. tsc 출력 형태가 바뀐 듯하니 ' +
      'fix-cjs.mjs 의 패턴을 확인할 것 — 이대로 두면 CJS 릴레이에서 cashu-ts 로딩이 깨진다.',
  );
}
