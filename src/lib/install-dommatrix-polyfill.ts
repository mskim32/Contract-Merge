/**
 * pdfjs 등 일부 라이브러리가 브라우저 전역(DOMMatrix/DOMPoint)을 전제로 로드됩니다.
 * Node(Vercel 서버리스)에는 없어 ReferenceError가 날 수 있어, API 라우트보다 먼저 적용합니다.
 */

function install(): void {
  const g = globalThis as unknown as {
    DOMMatrix?: unknown;
    DOMPoint?: unknown;
  };

  if (typeof g.DOMMatrix === "undefined") {
    class DOMMatrixPolyfill {
      m11 = 1;
      m12 = 0;
      m13 = 0;
      m14 = 0;
      m21 = 0;
      m22 = 1;
      m23 = 0;
      m24 = 0;
      m31 = 0;
      m32 = 0;
      m33 = 1;
      m34 = 0;
      m41 = 0;
      m42 = 0;
      m43 = 0;
      m44 = 1;
      a = 1;
      b = 0;
      c = 0;
      d = 1;
      e = 0;
      f = 0;
      is2D = true;
      isIdentity = true;

      constructor(_init?: unknown) {
        /* identity — pdfjs 텍스트 추출 경로에서만 필요한 경우가 많음 */
      }

      multiplySelf() {
        return this;
      }
      preMultiplySelf() {
        return this;
      }
      translateSelf() {
        return this;
      }
      scaleSelf() {
        return this;
      }
      rotateSelf() {
        return this;
      }
      invertSelf() {
        return this;
      }
      toString() {
        return "matrix(1,0,0,1,0,0)";
      }

      static fromMatrix() {
        return new DOMMatrixPolyfill();
      }
      static fromFloat32Array() {
        return new DOMMatrixPolyfill();
      }
      static fromFloat64Array() {
        return new DOMMatrixPolyfill();
      }
    }

    g.DOMMatrix = DOMMatrixPolyfill as unknown as typeof g.DOMMatrix;
  }

  if (typeof g.DOMPoint === "undefined") {
    class DOMPointPolyfill {
      x: number;
      y: number;
      z: number;
      w: number;
      constructor(x = 0, y = 0, z = 0, w = 1) {
        this.x = x;
        this.y = y;
        this.z = z;
        this.w = w;
      }
    }
    g.DOMPoint = DOMPointPolyfill as unknown as typeof g.DOMPoint;
  }
}

install();

export {};
