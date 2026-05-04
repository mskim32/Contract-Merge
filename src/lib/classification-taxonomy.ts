import fs from "fs/promises";
import path from "path";

export type TaxonomyMinor = { id: string; label: string };
export type TaxonomyMajor = { id: string; label: string; minors: TaxonomyMinor[] };
export type TaxonomyTrade = { id: string; label: string; majors: TaxonomyMajor[] };

export type ClassificationTaxonomy = {
  meta?: { title?: string; version?: number; notes?: string };
  fallback: { trade: string; majorCategory: string; minorCategory: string };
  trades: TaxonomyTrade[];
};

let cached: ClassificationTaxonomy | null = null;
let cachedPath: string | null = null;

function defaultTaxonomyPath(): string {
  const fromEnv = process.env.CLASSIFICATION_TAXONOMY_PATH?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(
    /* turbopackIgnore: true */ process.cwd(),
    "reference-data",
    "classification-taxonomy",
    "taxonomy.json"
  );
}

export async function loadClassificationTaxonomy(): Promise<ClassificationTaxonomy> {
  const filePath = defaultTaxonomyPath();
  if (cached && cachedPath === filePath) return cached;
  const raw = await fs.readFile(filePath, "utf-8");
  cached = JSON.parse(raw) as ClassificationTaxonomy;
  cachedPath = filePath;
  return cached;
}

/** 프롬프트용: meta 제외한 핵심만 JSON 문자열 */
export function taxonomyPromptPayload(tax: ClassificationTaxonomy): string {
  return JSON.stringify(
    { fallback: tax.fallback, trades: tax.trades },
    null,
    2
  );
}

function norm(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

function findTrade(tax: ClassificationTaxonomy, tradeLabel: string): TaxonomyTrade | undefined {
  const n = norm(tradeLabel);
  return tax.trades.find(
    (t) =>
      norm(t.id) === n ||
      norm(t.label) === n ||
      t.id === tradeLabel ||
      t.label === tradeLabel
  );
}

function findMajor(tr: TaxonomyTrade, majorLabel: string): TaxonomyMajor | undefined {
  const n = norm(majorLabel);
  return tr.majors.find(
    (m) =>
      norm(m.id) === n ||
      norm(m.label) === n ||
      m.id === majorLabel ||
      m.label === majorLabel
  );
}

function findMinor(ma: TaxonomyMajor, minorLabel: string): TaxonomyMinor | undefined {
  const n = norm(minorLabel);
  return ma.minors.find(
    (x) =>
      norm(x.id) === n ||
      norm(x.label) === n ||
      x.id === minorLabel ||
      x.label === minorLabel
  );
}

export type ClampedTriple = {
  trade: string;
  majorCategory: string;
  minorCategory: string;
};

/**
 * taxonomy.json 의 label/id 만 허용. 불일치 시 fallback 으로 수렴.
 */
export function clampTradeMajorMinor(
  tax: ClassificationTaxonomy,
  input: { trade?: string; majorCategory?: string; minorCategory?: string }
): ClampedTriple {
  const fb = tax.fallback;
  const tradeRaw = (input.trade ?? "").trim();
  const majorRaw = (input.majorCategory ?? "").trim();
  const minorRaw = (input.minorCategory ?? "").trim();

  const tr = tradeRaw ? findTrade(tax, tradeRaw) : undefined;
  if (!tr) {
    return {
      trade: fb.trade,
      majorCategory: fb.majorCategory,
      minorCategory: fb.minorCategory,
    };
  }

  const ma = majorRaw ? findMajor(tr, majorRaw) : undefined;
  if (!ma) {
    return {
      trade: tr.label,
      majorCategory: fb.majorCategory,
      minorCategory: fb.minorCategory,
    };
  }

  const mi = minorRaw ? findMinor(ma, minorRaw) : undefined;
  if (!mi) {
    return {
      trade: tr.label,
      majorCategory: ma.label,
      minorCategory: fb.minorCategory,
    };
  }

  return {
    trade: tr.label,
    majorCategory: ma.label,
    minorCategory: mi.label,
  };
}

/**
 * 구형 groupKey("공종-대분류-소분류") 보조 파싱 — 라벨에 '-' 가 있으면 깨질 수 있음.
 */
export function splitGroupKeyLoose(groupKey: string): {
  trade: string;
  majorCategory: string;
  minorCategory: string;
} {
  const parts = groupKey.split("-").map((p) => p.trim());
  return {
    trade: parts[0] || "",
    majorCategory: parts[1] || "",
    minorCategory: parts.slice(2).join("-") || "",
  };
}

/** 병합 맵 키: 라벨에 특수문자가 있어도 안전 */
export function makeTaxonomyMergeKey(c: ClampedTriple): string {
  return JSON.stringify([c.trade, c.majorCategory, c.minorCategory]);
}
