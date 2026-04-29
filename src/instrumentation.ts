/**
 * 서버(Node) 기동 시 DOMMatrix 등 브라우저 전역을 한 번 보강합니다.
 * 일부 의존성이 모듈 로드 시점에 global을 참조하는 경우 대비.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("@/lib/install-dommatrix-polyfill");
  }
}
