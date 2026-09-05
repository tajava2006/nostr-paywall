import { fileURLToPath } from 'node:url';

// 패키지 main 은 소비자용으로 `dist` 를 가리킨다(NestJS 등은 node_modules 의 생 TS 를 못 읽는다).
// 하지만 워크스페이스 안에서까지 dist 를 보면 테스트마다 빌드해야 한다 → 개발 중엔 src 로 돌린다.
const src = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export const workspaceAlias = {
  '@nostr-paywall/protocol': src('protocol'),
  '@nostr-paywall/collectors': src('collectors'),
  '@nostr-paywall/relay-guard': src('relay-guard'),
  '@nostr-paywall/client': src('client'),
};
