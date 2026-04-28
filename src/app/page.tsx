"use client";

import React, { useEffect, useState, useRef, useMemo } from "react";
import { UploadCloud, FileText, Loader2, Download, CheckCircle, Search, Filter, X, MapPin, Copy } from "lucide-react";
import * as XLSX from "xlsx";

type ExtractedData = {
  trade?: string;
  majorCategory?: string;
  middleCategory?: string;
  minorCategory?: string;
  content: string;
  sourceFile?: string;
};

type DuplicateVariation = {
  sourceFile: string;
  content: string;
};

type GroupedData = {
  trade: string;
  majorCategory: string;
  middleCategory: string;
  minorCategory: string;
  count: number;
  variations: DuplicateVariation[];
};

type GeneralConditionReview = {
  itemIndex: number;
  content: string;
  matchType: '완전중복' | '부분중복' | '신규(고유)';
  matchedGeneralClause: string | null;
  explanation: string;
};

type LegalRiskReview = {
  itemIndex: number;
  content: string;
  riskLevel: '🔴 위반(고위험)' | '🟡 주의(중위험)' | '🟢 적법(저위험)';
  violatedLaw: string | null;
  riskDescription: string;
  suggestedFix: string | null;
};

type ScannedFile = { id: string; file: File; length?: number; isScanning: boolean; isSelected: boolean; isAnalyzed: boolean };
type RevisionTarget = { index: number; originalContent: string; review: LegalRiskReview };
type DeepRiskFilter = "all" | "red" | "yellow" | "green";
type DeepGeneralFilter = "all" | "완전중복" | "부분중복" | "신규(고유)";
type DiffPart = { type: "equal" | "remove" | "add"; text: string };
type RiskDetailModal = {
  riskLevel: string;
  violatedLaw: string | null;
  riskDescription: string;
} | null;

type GeneralConditionDetailModal = {
  matchType: GeneralConditionReview["matchType"];
  explanation: string;
  matchedGeneralClause: string | null;
  siteClauseContent: string;
} | null;

const isAbortError = (error: unknown): boolean => {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  if (error && typeof error === "object" && "name" in error && (error as Error).name === "AbortError")
    return true;
  return false;
};

const getWordDiffParts = (oldText: string, newText: string): DiffPart[] => {
  const before = oldText.trim().split(/\s+/).filter(Boolean);
  const after = newText.trim().split(/\s+/).filter(Boolean);

  const n = before.length;
  const m = after.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (before[i - 1] === after[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const raw: DiffPart[] = [];
  let i = n;
  let j = m;

  while (i > 0 && j > 0) {
    if (before[i - 1] === after[j - 1]) {
      raw.push({ type: "equal", text: before[i - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      raw.push({ type: "remove", text: before[i - 1] });
      i--;
    } else {
      raw.push({ type: "add", text: after[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    raw.push({ type: "remove", text: before[i - 1] });
    i--;
  }
  while (j > 0) {
    raw.push({ type: "add", text: after[j - 1] });
    j--;
  }

  raw.reverse();

  const merged: DiffPart[] = [];
  raw.forEach((part) => {
    const last = merged[merged.length - 1];
    if (last && last.type === part.type) {
      last.text += ` ${part.text}`;
    } else {
      merged.push({ ...part });
    }
  });

  return merged;
};

type PhaseDurations = {
  stage1Ms?: number;
  stage2Ms?: number;
  stage3Ms?: number;
  fullAnalysisMs?: number;
};

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0초";
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}시간 ${m}분 ${s}초`;
  if (m > 0) return `${m}분 ${s}초`;
  return `${s}초`;
}

function formatElapsedClock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function CheckMatePage() {
  const [isDragging, setIsDragging] = useState(false);
  const [scanQueue, setScanQueue] = useState<ScannedFile[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressStatus, setProgressStatus] = useState<string>("");
  const [results, setResults] = useState<ExtractedData[] | null>(null);

  // New States
  const [siteName, setSiteName] = useState<string | null>(null);
  /** 워드 머리글/상단에서 추출한 주공종(행 trade 집계와 무관) */
  const [mainTradeName, setMainTradeName] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'all' | 'duplicates' | 'deep_review'>('all');
  const [duplicatesResults, setDuplicatesResults] = useState<GroupedData[]>([]);
  const [isAnalyzingDuplicates, setIsAnalyzingDuplicates] = useState(false);
  
  // Phase 3 States
  const [isDeepReviewing, setIsDeepReviewing] = useState(false);
  const [generalReviews, setGeneralReviews] = useState<Record<string, GeneralConditionReview>>({});
  const [legalReviews, setLegalReviews] = useState<Record<string, LegalRiskReview>>({});
  const [initialLegalReviews, setInitialLegalReviews] = useState<Record<string, LegalRiskReview>>({});
  const [appliedSuggestedFixMap, setAppliedSuggestedFixMap] = useState<Record<string, boolean>>({});
  const [revisionTarget, setRevisionTarget] = useState<RevisionTarget | null>(null);
  const [editedSuggestedFix, setEditedSuggestedFix] = useState("");
  const [reviseRequestText, setReviseRequestText] = useState("");
  const [isRegeneratingFix, setIsRegeneratingFix] = useState(false);
  const [regenerateError, setRegenerateError] = useState<string | null>(null);
  const [riskDetailModal, setRiskDetailModal] = useState<RiskDetailModal>(null);
  const [generalConditionDetailModal, setGeneralConditionDetailModal] =
    useState<GeneralConditionDetailModal>(null);
  const [isRunningFullAnalysis, setIsRunningFullAnalysis] = useState(false);
  const [phaseDurations, setPhaseDurations] = useState<PhaseDurations>({});
  const [elapsedTick, setElapsedTick] = useState(0);

  // Filter States
  const [filterTrade, setFilterTrade] = useState<string>("All");
  const [filterMajor, setFilterMajor] = useState<string>("All");
  const [deepRiskFilter, setDeepRiskFilter] = useState<DeepRiskFilter>("all");
  const [deepGeneralFilter, setDeepGeneralFilter] = useState<DeepGeneralFilter>("all");
  const [deepSelectedMap, setDeepSelectedMap] = useState<Record<string, boolean>>(
    {}
  );

  const fileInputRef = useRef<HTMLInputElement>(null);
  const stage1AbortRef = useRef<AbortController | null>(null);
  const stage2AbortRef = useRef<AbortController | null>(null);
  const stage34AbortRef = useRef<AbortController | null>(null);
  const isProcessingRef = useRef(false);
  const isAnalyzingDuplicatesRef = useRef(false);
  const isDeepReviewingRef = useRef(false);
  const resultsRef = useRef<ExtractedData[] | null>(null);
  const duplicatesResultsRef = useRef<GroupedData[]>([]);
  const mainTradeNameRef = useRef<string | null>(null);
  const liveSessionStartRef = useRef<number | null>(null);

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFiles(Array.from(e.dataTransfer.files));
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(Array.from(e.target.files));
    }
  };

  useEffect(() => {
    isProcessingRef.current = isProcessing;
  }, [isProcessing]);

  useEffect(() => {
    isAnalyzingDuplicatesRef.current = isAnalyzingDuplicates;
  }, [isAnalyzingDuplicates]);

  useEffect(() => {
    isDeepReviewingRef.current = isDeepReviewing;
  }, [isDeepReviewing]);

  useEffect(() => {
    resultsRef.current = results;
  }, [results]);

  useEffect(() => {
    duplicatesResultsRef.current = duplicatesResults;
  }, [duplicatesResults]);

  useEffect(() => {
    mainTradeNameRef.current = mainTradeName;
  }, [mainTradeName]);

  const anyAnalysisBusy =
    isProcessing ||
    isAnalyzingDuplicates ||
    isDeepReviewing ||
    isRunningFullAnalysis;

  useEffect(() => {
    if (anyAnalysisBusy && liveSessionStartRef.current === null) {
      liveSessionStartRef.current = Date.now();
    }
    if (!anyAnalysisBusy) {
      liveSessionStartRef.current = null;
    }
  }, [anyAnalysisBusy]);

  useEffect(() => {
    if (!anyAnalysisBusy) return;
    const id = window.setInterval(() => setElapsedTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [anyAnalysisBusy]);

  const addFiles = async (files: File[]) => {
    const validFiles = files.filter(f => f.name.endsWith(".docx"));
    if (validFiles.length !== files.length) {
      alert("일부 파일은 제외되었습니다. .docx 파일만 업로드 가능합니다.");
    }

    if (results && !isProcessing) {
      // 새로운 배치 추가를 위해 초기화하지 않고 그대로 이어감
    }

    const newItems: ScannedFile[] = validFiles.map(f => ({
      id: Math.random().toString(36).substr(2, 9),
      file: f,
      isScanning: true,
      isSelected: true,
      isAnalyzed: false
    }));

    setScanQueue(prev => [...prev, ...newItems]);

    const fileToBase64 = (file: File) => new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve((reader.result as string).split(',')[1]);
      reader.onerror = error => reject(error);
    });

    for (const item of newItems) {
      try {
        const base64 = await fileToBase64(item.file);
        const res = await fetch("/api/scan-docx", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ base64 }),
        });
        if (res.ok) {
          const { textLength } = await res.json();
          setScanQueue(prev => prev.map(q => q.id === item.id ? { ...q, length: textLength, isScanning: false } : q));
        } else {
          setScanQueue(prev => prev.map(q => q.id === item.id ? { ...q, isScanning: false } : q));
        }
      } catch (e) {
        setScanQueue(prev => prev.map(q => q.id === item.id ? { ...q, isScanning: false } : q));
      }
    }
  };

  const removeScanItem = (idToRemove: string) => {
    setScanQueue(prev => prev.filter(q => q.id !== idToRemove));
  };

  const toggleSelect = (id: string) => {
    setScanQueue(prev => prev.map(q => q.id === id ? { ...q, isSelected: !q.isSelected } : q));
  }

  const clearFiles = () => {
    stage1AbortRef.current?.abort();
    stage2AbortRef.current?.abort();
    stage34AbortRef.current?.abort();
    setScanQueue([]);
    setResults(null);
    setSiteName(null);
    setMainTradeName(null);
    setActiveTab("all");
    setDuplicatesResults([]);
    setGeneralReviews({});
    setLegalReviews({});
    setInitialLegalReviews({});
    setAppliedSuggestedFixMap({});
    setRevisionTarget(null);
    setEditedSuggestedFix("");
    setFilterTrade("All");
    setFilterMajor("All");
    setDeepRiskFilter("all");
    setDeepGeneralFilter("all");
    setDeepSelectedMap({});
    setRiskDetailModal(null);
    setGeneralConditionDetailModal(null);
    setProgressStatus("");
    setPhaseDurations({});
  };

  const processFile = async () => {
    if (isProcessing) {
      stage1AbortRef.current?.abort(new DOMException("1단계 사용자 중단", "AbortError"));
      setProgressStatus("1단계 분석 중단 요청 중...");
      return;
    }

    // React state를 즉시 캡처
    setScanQueue(currentQueue => {
      const targets = currentQueue.filter(q => q.isSelected && !q.isAnalyzed);
      if (targets.length === 0) return currentQueue;

      // 비동기 실행 영역을 별도로 분리하여 비동기 처리
      (async () => {
        const controller = new AbortController();
        stage1AbortRef.current = controller;
        let stage1Start = 0;

        try {
          setIsProcessing(true);
          stage1Start = Date.now();
          setActiveTab('all');

          const fileToBase64 = (file: File) => new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.readAsDataURL(file);
            reader.onload = () => resolve((reader.result as string).split(',')[1]);
            reader.onerror = error => reject(error);
          });

          // 현장명·주공종 추출 (첫 대상 파일, 워드 머리글/상단 — ref로 이미 추출 여부 판단)
          if (
            targets.length > 0 &&
            (!siteName || mainTradeNameRef.current === null)
          ) {
            try {
              setProgressStatus(
                "메인 문서 스캔 중... 현장명·주공종(머리글)을 파악하고 있습니다."
              );
              const firstFileBase64 = await fileToBase64(targets[0].file);
              const needSite = !siteName;
              const needMainTrade = mainTradeNameRef.current === null;
              const siteP = needSite
                ? fetch("/api/extract-site-name", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ base64: firstFileBase64 }),
                    signal: controller.signal,
                  })
                : Promise.resolve(null);
              const tradeP = needMainTrade
                ? fetch("/api/extract-main-trade", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ base64: firstFileBase64 }),
                    signal: controller.signal,
                  })
                : Promise.resolve(null);
              const [siteRes, tradeRes] = await Promise.all([siteP, tradeP]);
              if (controller.signal.aborted) {
                /* no-op */
              } else {
                if (siteRes?.ok) {
                  const snb = await siteRes.json();
                  if (snb.siteName) setSiteName(snb.siteName);
                }
                if (tradeRes) {
                  if (tradeRes.ok) {
                    const tj = await tradeRes.json();
                    const mt =
                      typeof tj.mainTrade === "string" ? tj.mainTrade.trim() : "";
                    setMainTradeName(mt.length > 0 ? mt : "알 수 없음");
                  } else {
                    setMainTradeName("알 수 없음");
                  }
                }
              }
            } catch (e) {
              if (isAbortError(e)) return;
              console.error("현장명/주공종 추출 실패", e);
              if (mainTradeNameRef.current === null) setMainTradeName("알 수 없음");
            }
          }

          const CONCURRENT_FILES = 2;
          let completedCount = 0;
          setProgressStatus(`총 ${targets.length}개 파일 쾌속 분석 개시... (동시 ${CONCURRENT_FILES}개씩 파이프라인 처리)`);

          for (let i = 0; i < targets.length; i += CONCURRENT_FILES) {
            if (controller.signal.aborted) break;
            const batch = targets.slice(i, i + CONCURRENT_FILES);
            const batchNames = batch.map(b => b.file.name).join(', ');
            setProgressStatus(`[${Math.min(i + CONCURRENT_FILES, targets.length)} / ${targets.length}] "${batchNames}" 병렬 추출 중...`);

            await Promise.all(batch.map(async (item) => {
              try {
                if (controller.signal.aborted) return;
                const base64Data = await fileToBase64(item.file);
                if (controller.signal.aborted) return;
                const payload = { files: [{ name: item.file.name, base64: base64Data }] };

                const response = await fetch("/api/analyze-docx", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(payload),
                  signal: controller.signal,
                });

                if (response.ok) {
                  const { data } = await response.json();
                  if (controller.signal.aborted) return;
                  if (data && Array.isArray(data) && data.length > 0) {
                    // 끝난 즉시 화면 테이블 맨 밑으로 Append! (점진적 렌더링)
                    setResults(prev => {
                      const prevData = prev || [];
                      return [...prevData, ...data];
                    });
                    // 유효 결과가 있을 때만 완료 상태로 변경
                    setScanQueue(prev => prev.map(q => q.id === item.id ? { ...q, isAnalyzed: true, isSelected: false } : q));
                  } else {
                    // 503 등으로 AI가 빈 결과를 반환한 경우 재시도 가능하도록 남겨둔다.
                    console.warn(`[API] 분석 결과 0건 (${item.file.name}) - 재시도 필요`);
                  }
                } else {
                  console.error(`[API] 분석 실패 (${item.file.name})`);
                }
              } catch (e) {
                if (isAbortError(e)) return;
                console.error(`[API] Network/Parsing Error for ${item.file.name}`, e);
              } finally {
                completedCount++;
              }
            }));
          }
          setProgressStatus(controller.signal.aborted ? "1단계 분석이 중단되었습니다." : "");
        } catch (error: any) {
          if (isAbortError(error)) {
            setProgressStatus("1단계 분석이 중단되었습니다.");
            return;
          }
          console.error("Processing error:", error);
          alert(`오류 발생: ${error.message || String(error)}\n(개발자 콘솔을 확인해 주세요)`);
        } finally {
          stage1AbortRef.current = null;
          if (stage1Start > 0) {
            setPhaseDurations((p) => ({ ...p, stage1Ms: Date.now() - stage1Start }));
          }
          setIsProcessing(false);
        }
      })().catch((err) => {
        if (!isAbortError(err)) console.error("[Stage 1] 처리 오류:", err);
      });

      return currentQueue;
    });
  };

  const processDuplicates = async (itemsOverride?: ExtractedData[]) => {
    if (isAnalyzingDuplicatesRef.current) {
      stage2AbortRef.current?.abort();
      return [];
    }

    const targetItems = itemsOverride ?? filteredResults;
    if (!targetItems || targetItems.length === 0) return [];

    const controller = new AbortController();
    stage2AbortRef.current = controller;

    let stage2Start = 0;
    try {
      stage2Start = Date.now();
      setIsAnalyzingDuplicates(true);
      setDuplicatesResults([]);

      const response = await fetch("/api/analyze-duplicates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: targetItems }),
        signal: controller.signal,
      });

      if (response.ok) {
        const { data } = await response.json();
        if (controller.signal.aborted) return [];
        const newDuplicates = data || [];
        setDuplicatesResults(newDuplicates);

        // 전체 리스트(results)에도 2단계 분석(분류화) 결과를 병합하여 업데이트
        if (newDuplicates.length > 0) {
          setResults(prevResults => {
            if (!prevResults) return null;
            return prevResults.map(item => {
              for (const group of newDuplicates) {
                const found = group.variations.find((v: DuplicateVariation) =>
                  v.content === item.content && v.sourceFile === item.sourceFile
                );
                if (found) {
                  return {
                    ...item,
                    trade: group.trade || item.trade,
                    majorCategory: group.majorCategory || item.majorCategory,
                    middleCategory: group.middleCategory || item.middleCategory,
                    minorCategory: group.minorCategory || item.minorCategory
                  };
                }
              }
              return item;
            });
          });
        }
        return newDuplicates;
      } else {
        console.error("Duplicate API failed");
        alert("AI 분석 중 장애가 발생했습니다. 잠시 후 시도해주세요.");
        return [];
      }
    } catch (error) {
      if (isAbortError(error)) return [];
      console.error("Duplicate processing error:", error);
      alert("분석 요청 중 알 수 없는 오류가 발생했습니다.");
      return [];
    } finally {
      stage2AbortRef.current = null;
      setPhaseDurations((p) => ({ ...p, stage2Ms: Date.now() - stage2Start }));
      setIsAnalyzingDuplicates(false);
    }
  };

  // Phase 3 Deep Review Function
  const processDeepReview = async (duplicatesOverride?: GroupedData[]) => {
    const targetDuplicates = duplicatesOverride ?? duplicatesResults;
    if (isDeepReviewing) {
      stage34AbortRef.current?.abort();
      return;
    }

    if (!targetDuplicates || targetDuplicates.length === 0) {
      alert("먼저 2단계(분류화) 작업을 완료해주세요.");
      return;
    }

    const controller = new AbortController();
    stage34AbortRef.current = controller;

    let stage3Start = 0;
    try {
      stage3Start = Date.now();
      setIsDeepReviewing(true);
      setActiveTab('deep_review');

      // Prepare items. Only need to send 1 representative content per group or send all variations?
      // Since variations have identical meaning, sending the first variation of each group saves tokens.
      const itemsToReview = targetDuplicates.map((g, idx) => ({
        index: idx.toString(),
        content: g.variations[0].content, // Send representative content
      }));
      setDeepSelectedMap(() => {
        const next: Record<string, boolean> = {};
        targetDuplicates.forEach((_, idx) => {
          next[idx.toString()] = true;
        });
        return next;
      });

      // Call General Conditions Match API
      const generalRes = fetch("/api/review-general-conditions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: itemsToReview }),
        signal: controller.signal,
      });

      // Call Legal Risk Match API
      const legalRes = fetch("/api/review-legal-risk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: itemsToReview }),
        signal: controller.signal,
      });

      const [generalRaw, legalRaw] = await Promise.all([generalRes, legalRes]);
      if (controller.signal.aborted) return;

      let generalOk = false;
      let legalOk = false;

      if (generalRaw.ok) {
        const { data } = await generalRaw.json();
        const map: Record<string, GeneralConditionReview> = {};
        data?.forEach((d: GeneralConditionReview) => {
          map[String(d.itemIndex)] = d;
        });
        setGeneralReviews(map);
        generalOk = true;
      } else {
        const errBody = await generalRaw.text();
        console.error(
          "[Deep review] review-general-conditions failed",
          generalRaw.status,
          errBody
        );
        setGeneralReviews({});
      }

      if (legalRaw.ok) {
        const { data } = await legalRaw.json();
        const map: Record<string, LegalRiskReview> = {};
        data?.forEach((d: LegalRiskReview) => {
          map[String(d.itemIndex)] = d;
        });
        setLegalReviews(map);
        setInitialLegalReviews(map);
        legalOk = true;
      } else {
        const errBody = await legalRaw.text();
        console.error("[Deep review] review-legal-risk failed", legalRaw.status, errBody);
        setLegalReviews({});
        setInitialLegalReviews({});
      }

      if (!generalOk && !legalOk) {
        alert(
          "일반조건 대조와 법률 리스크 검토 API가 모두 실패했습니다. 잠시 후 다시 시도해주세요."
        );
        return;
      }
      if (!generalOk) {
        alert(
          "일반조건 대조 API에 실패했습니다. 표준(일반) 진단 열이 비어 있을 수 있습니다."
        );
      }
      if (!legalOk) {
        alert(
          "법률 리스크 검토 API에 실패했습니다. 법률 진단 열이 비어 있을 수 있습니다."
        );
      }
    } catch (e) {
      if (isAbortError(e)) return;
      console.error("Deep review error", e);
      alert("심층 검토 중 오류가 발생했습니다.");
    } finally {
      stage34AbortRef.current = null;
      if (stage3Start > 0) {
        setPhaseDurations((p) => ({ ...p, stage3Ms: Date.now() - stage3Start }));
      }
      setIsDeepReviewing(false);
    }
  };

  const waitUntil = async (condition: () => boolean, timeoutMs: number, intervalMs = 200) => {
    const start = Date.now();
    while (!condition()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error("작업 대기 시간이 초과되었습니다.");
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  };

  const waitForStartThenFinish = async (
    isRunning: () => boolean,
    startTimeoutMs: number,
    finishTimeoutMs: number,
    stepName: string
  ) => {
    await waitUntil(() => isRunning(), startTimeoutMs).catch(() => {
      throw new Error(`${stepName}가 시작되지 않았습니다.`);
    });
    await waitUntil(() => !isRunning(), finishTimeoutMs);
  };

  const runFullAnalysis = async () => {
    if (isProcessingRef.current || isAnalyzingDuplicatesRef.current || isDeepReviewingRef.current) {
      alert("이미 분석이 진행 중입니다. 현재 작업 완료 후 다시 시도해주세요.");
      return;
    }

    if (!scanQueue.some(q => q.isSelected && !q.isAnalyzed)) {
      alert("1단계 분석 대상 파일을 먼저 선택해주세요.");
      return;
    }

    let fullAnalysisStart = 0;
    try {
      fullAnalysisStart = Date.now();
      setIsRunningFullAnalysis(true);
      let step1Success = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        setProgressStatus(attempt === 1 ? "원클릭 분석: 1단계 시작" : "원클릭 분석: 1단계 재시도");
        const baselineResultsCount = resultsRef.current?.length ?? 0;
        processFile();
        await waitForStartThenFinish(
          () => isProcessingRef.current,
          4000,
          1000 * 60 * 10,
          "1단계"
        );

        // 1단계 완료 직후 React state 반영이 한 템포 늦을 수 있어, 결과 증가를 짧게 추가 대기.
        await waitUntil(
          () => (resultsRef.current?.length ?? 0) > baselineResultsCount,
          3000,
          100
        ).catch(() => {
          // 증가가 없으면 아래 분기에서 재시도/실패 판정.
        });

        if ((resultsRef.current?.length ?? 0) > baselineResultsCount || (resultsRef.current?.length ?? 0) > 0) {
          step1Success = true;
          break;
        }
      }

      if (!step1Success) {
        throw new Error("1단계 결과가 없습니다. AI 서버 과부하(503)일 수 있어 잠시 후 다시 시도해주세요.");
      }

      setProgressStatus("원클릭 분석: 2단계 시작");
      const step2Results = await processDuplicates(resultsRef.current || []);

      if (!step2Results || step2Results.length === 0) {
        throw new Error("2단계 결과가 없어 3단계를 진행할 수 없습니다.");
      }

      setProgressStatus("원클릭 분석: 3단계 시작");
      await processDeepReview(step2Results);
      await waitUntil(() => !isDeepReviewingRef.current, 1000 * 60 * 10);
      setProgressStatus("원클릭 분석 완료");
    } catch (error: any) {
      console.error("Full analysis error:", error);
      alert(`원클릭 전체 분석 중 오류가 발생했습니다: ${error?.message || String(error)}`);
    } finally {
      if (fullAnalysisStart > 0) {
        setPhaseDurations((p) => ({
          ...p,
          fullAnalysisMs: Date.now() - fullAnalysisStart,
        }));
      }
      setIsRunningFullAnalysis(false);
      setTimeout(() => setProgressStatus(""), 1200);
    }
  };

  const openReviseClauseModal = (index: number, originalContent: string, review: LegalRiskReview) => {
    setRevisionTarget({ index, originalContent, review });
    setEditedSuggestedFix(review.suggestedFix || "");
    setReviseRequestText("법적 리스크는 해소하면서, 기존 현장 실무 의도는 유지해 더 명확하게 작성해줘.");
    setRegenerateError(null);
  };

  const closeReviseClauseModal = () => {
    setRevisionTarget(null);
    setEditedSuggestedFix("");
    setReviseRequestText("");
    setRegenerateError(null);
    setIsRegeneratingFix(false);
  };

  const regenerateSuggestedFix = async () => {
    if (!revisionTarget) return;
    const userRequest = reviseRequestText.trim() || "기존 의도는 유지하고 법적으로 안전한 문구로 다시 제안해줘.";
    const review = revisionTarget.review;

    try {
      setIsRegeneratingFix(true);
      setRegenerateError(null);
      const response = await fetch("/api/revise-legal-clause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originalContent: revisionTarget.originalContent,
          violatedLaw: review.violatedLaw,
          riskDescription: review.riskDescription,
          previousSuggestedFix: editedSuggestedFix || review.suggestedFix,
          userRequest,
        }),
      });

      if (!response.ok) {
        const txt = await response.text();
        throw new Error(txt || "AI 재생성 요청 실패");
      }
      const payload = await response.json();
      const next = payload?.data?.revisedContent;
      if (!next || typeof next !== "string") {
        throw new Error("AI 재생성 응답에 revisedContent가 없습니다.");
      }
      setEditedSuggestedFix(next.trim());
    } catch (error: any) {
      console.error("재생성 실패:", error);
      setRegenerateError(error?.message || "문구 재생성 중 오류가 발생했습니다.");
    } finally {
      setIsRegeneratingFix(false);
    }
  };

  const saveEditedSuggestedFix = () => {
    if (!revisionTarget) return;
    const nextText = editedSuggestedFix.trim();
    if (!nextText) {
      alert("수정 문구를 입력해주세요.");
      return;
    }

    const { index } = revisionTarget;
    const idxKey = index.toString();
    setLegalReviews(prev => {
      const current = prev[idxKey];
      if (!current) return prev;
      return {
        ...prev,
        [idxKey]: {
          ...current,
          suggestedFix: nextText,
        },
      };
    });
    setAppliedSuggestedFixMap(prev => ({ ...prev, [idxKey]: true }));
    closeReviseClauseModal();
  };

  const isSuggestedFixEdited = (idxKey: string): boolean => {
    const current = legalReviews[idxKey]?.suggestedFix ?? "";
    const original = initialLegalReviews[idxKey]?.suggestedFix ?? "";
    return current.trim() !== original.trim();
  };

  // Unique lists for filtering
  const uniqueTrades = useMemo(() => {
    if (!results) return [];
    return Array.from(new Set(results.map(r => r.trade).filter(Boolean)));
  }, [results]);

  const uniqueMajors = useMemo(() => {
    if (!results) return [];
    return Array.from(new Set(results.map(r => r.majorCategory).filter(Boolean)));
  }, [results]);

  /** 머리글 기반 주공종 1개만 (표 행 trade 집계와 무관) */
  const headerTradeText = useMemo(() => {
    if (mainTradeName === null) return null;
    const t = mainTradeName.trim();
    return t.length > 0 ? t : "알 수 없음";
  }, [mainTradeName]);

  // Actual filtered results based on selected filters
  const filteredResults = useMemo(() => {
    if (!results) return [];
    return results.filter(
      (r) => (filterTrade === "All" || r.trade === filterTrade) &&
        (filterMajor === "All" || r.majorCategory === filterMajor)
    );
  }, [results, filterTrade, filterMajor]);

  const deepReviewRows = useMemo(() => {
    return duplicatesResults
      .map((row, index) => {
        const idxStr = index.toString();
        const gReview = generalReviews[idxStr];
        const lReview = legalReviews[idxStr];
        return { row, index, idxStr, gReview, lReview };
      })
      .filter(({ gReview, lReview }) => {
        const riskOk =
          deepRiskFilter === "all" ||
          (deepRiskFilter === "red" && !!lReview && lReview.riskLevel.includes("위반")) ||
          (deepRiskFilter === "yellow" && !!lReview && lReview.riskLevel.includes("주의")) ||
          (deepRiskFilter === "green" && !!lReview && lReview.riskLevel.includes("적법"));

        const generalOk =
          deepGeneralFilter === "all" ||
          (!!gReview && gReview.matchType === deepGeneralFilter);

        return riskOk && generalOk;
      });
  }, [duplicatesResults, generalReviews, legalReviews, deepRiskFilter, deepGeneralFilter]);

  const selectedDeepReviewRows = useMemo(
    () => deepReviewRows.filter(({ idxStr }) => !!deepSelectedMap[idxStr]),
    [deepReviewRows, deepSelectedMap]
  );

  const isAllVisibleDeepChecked =
    deepReviewRows.length > 0 &&
    deepReviewRows.every(({ idxStr }) => !!deepSelectedMap[idxStr]);
  const selectedVisibleDeepCount = selectedDeepReviewRows.length;

  const deepRiskCounts = useMemo(() => {
    let red = 0;
    let yellow = 0;
    let green = 0;
    Object.values(legalReviews).forEach((review) => {
      if (review.riskLevel.includes("위반")) red++;
      else if (review.riskLevel.includes("주의")) yellow++;
      else if (review.riskLevel.includes("적법")) green++;
    });
    return { red, yellow, green };
  }, [legalReviews]);

  const deepGeneralCounts = useMemo(() => {
    let full = 0;
    let partial = 0;
    let unique = 0;
    Object.values(generalReviews).forEach((review) => {
      if (review.matchType === "완전중복") full++;
      else if (review.matchType === "부분중복") partial++;
      else if (review.matchType === "신규(고유)") unique++;
    });
    return { full, partial, unique };
  }, [generalReviews]);

  const fullAnalysisDisabledReason = useMemo(() => {
    if (isRunningFullAnalysis) {
      if (progressStatus && progressStatus.includes("원클릭 분석")) return progressStatus;
      return "원클릭 전체 분석이 진행 중입니다.";
    }
    if (isProcessing) return "1단계 분석이 진행 중입니다.";
    if (isAnalyzingDuplicates) return "2단계 분석이 진행 중입니다.";
    if (isDeepReviewing) return "3단계 분석이 진행 중입니다.";
    if (!scanQueue.some(q => q.isSelected && !q.isAnalyzed)) {
      return "선택된 미분석 파일이 없습니다. 대기열에서 파일을 선택해 주세요.";
    }
    return null;
  }, [isRunningFullAnalysis, isProcessing, isAnalyzingDuplicates, isDeepReviewing, scanQueue, progressStatus]);

  const busyPhaseLabel = useMemo(() => {
    if (isRunningFullAnalysis) return "원클릭 전체 분석";
    if (isProcessing) return "1단계 추출";
    if (isAnalyzingDuplicates) return "2단계 분류화";
    if (isDeepReviewing) return "3단계 심층 분석";
    return "";
  }, [isRunningFullAnalysis, isProcessing, isAnalyzingDuplicates, isDeepReviewing]);

  const durationSummaryLine = useMemo(() => {
    const parts: string[] = [];
    if (phaseDurations.stage1Ms != null) {
      parts.push(`1단계 ${formatDurationMs(phaseDurations.stage1Ms)}`);
    }
    if (phaseDurations.stage2Ms != null) {
      parts.push(`2단계 ${formatDurationMs(phaseDurations.stage2Ms)}`);
    }
    if (phaseDurations.stage3Ms != null) {
      parts.push(`3단계 ${formatDurationMs(phaseDurations.stage3Ms)}`);
    }
    if (phaseDurations.fullAnalysisMs != null) {
      parts.push(`원클릭 전체 ${formatDurationMs(phaseDurations.fullAnalysisMs)}`);
    }
    return parts.length > 0 ? `소요 시간 · ${parts.join(" · ")}` : "";
  }, [phaseDurations]);

  // No useMemo for duplicates anymore; it is filled asyncly

  void elapsedTick;
  const liveElapsedMs =
    liveSessionStartRef.current != null ? Date.now() - liveSessionStartRef.current : 0;

  const downloadCSV = () => {
    if (!results || results.length === 0) return;
    if (activeTab === "deep_review" && deepReviewRows.length > 0 && selectedDeepReviewRows.length === 0) {
      alert("내보낼 3단계 항목을 1개 이상 체크해 주세요.");
      return;
    }

    const headers = activeTab === 'all'
      ? ["공종명(Trade)", "대분류(Major)", "중분류(Middle)", "소분류(Minor)", "내용(Content)", "출처문서"]
      : activeTab === 'duplicates'
        ? ["중복개소(Count)", "공종명(Trade)", "대분류(Major)", "소분류(Minor)", "현장별 변형 내용(Variations)"]
        : ["공종명", "대분류", "소분류", "원본 내용", "표준 진단결과", "법률 진단결과", "위반 근거", "리스크 설명", "수정문구 여부", "AI 초기 추천문구", "적용된 최종 문구"];

    const rows = activeTab === 'all'
      ? filteredResults.map((r: any) => [
          `"${r.trade}"`, `"${r.majorCategory}"`, `"${r.middleCategory}"`, `"${r.minorCategory}"`,
          `"${(r.content || "").replace(/"/g, '""')}"`, `"${r.sourceFile || ''}"`
        ])
      : activeTab === 'duplicates'
        ? duplicatesResults.map((r: any) => {
            const combinedVars = r.variations.map((v: DuplicateVariation) => `[${v.sourceFile}] ${v.content}`).join('\n').replace(/"/g, '""');
            return [
              `"${r.count}"`, `"${r.trade}"`, `"${r.majorCategory}"`, `"${r.minorCategory}"`,
              `"${combinedVars}"`
            ];
          })
        : selectedDeepReviewRows.map(({ row, idxStr, gReview, lReview }) => {
            const originalSuggested = initialLegalReviews[idxStr]?.suggestedFix || "";
            const currentSuggested = lReview?.suggestedFix || "";
            const edited = isSuggestedFixEdited(idxStr) ? "수정됨" : "미수정";
            return [
              `"${row.trade || ""}"`,
              `"${row.majorCategory || ""}"`,
              `"${row.minorCategory || ""}"`,
              `"${(row.variations[0]?.content || "").replace(/"/g, '""')}"`,
              `"${gReview?.matchType || ""}"`,
              `"${lReview?.riskLevel || ""}"`,
              `"${(lReview?.violatedLaw || "").replace(/"/g, '""')}"`,
              `"${(lReview?.riskDescription || "").replace(/"/g, '""')}"`,
              `"${edited}"`,
              `"${originalSuggested.replace(/"/g, '""')}"`,
              `"${currentSuggested.replace(/"/g, '""')}"`
            ];
          });

    const csvContent = [headers.join(","), ...rows.map(e => e.join(","))].join("\n");
    const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `Contract_Conditions_${activeTab}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const downloadExcel = () => {
    if (!results || results.length === 0) return;
    if (activeTab === "deep_review" && deepReviewRows.length > 0 && selectedDeepReviewRows.length === 0) {
      alert("내보낼 3단계 항목을 1개 이상 체크해 주세요.");
      return;
    }

    const headers = activeTab === 'all'
      ? ["공종명", "대분류", "중분류", "소분류", "견적 조건 원문 (내용)", "출처문서"]
      : activeTab === 'duplicates'
        ? ["중복개소", "공종명", "대분류", "소분류", "현장별 변형 내용"]
        : ["공종명", "대분류", "소분류", "원본 내용", "표준 진단결과", "법률 진단결과", "위반 근거", "리스크 설명", "수정문구 여부", "AI 초기 추천문구", "적용된 최종 문구"];

    const rows = activeTab === 'all'
      ? filteredResults.map((r: any) => [r.trade, r.majorCategory, r.middleCategory, r.minorCategory, r.content, r.sourceFile || ''])
      : activeTab === 'duplicates'
        ? duplicatesResults.map((r: any) => {
            const combinedVars = r.variations.map((v: DuplicateVariation) => `[${v.sourceFile}] ${v.content}`).join('\n');
            return [r.count, r.trade, r.majorCategory, r.minorCategory, combinedVars];
          })
        : selectedDeepReviewRows.map(({ row, idxStr, gReview, lReview }) => [
            row.trade || "",
            row.majorCategory || "",
            row.minorCategory || "",
            row.variations[0]?.content || "",
            gReview?.matchType || "",
            lReview?.riskLevel || "",
            lReview?.violatedLaw || "",
            lReview?.riskDescription || "",
            isSuggestedFixEdited(idxStr) ? "수정됨" : "미수정",
            initialLegalReviews[idxStr]?.suggestedFix || "",
            lReview?.suggestedFix || ""
          ]);

    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const workbook = XLSX.utils.book_new();
    const excelSheetName =
      activeTab === "all" ? "전체조건" : activeTab === "duplicates" ? "중복분석" : "심층분석";
    XLSX.utils.book_append_sheet(workbook, worksheet, excelSheetName);
    XLSX.writeFile(workbook, `Contract_Conditions_${activeTab}.xlsx`);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 font-sans selection:bg-blue-100 pb-20">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 bg-blue-600 rounded flex items-center justify-center">
              <CheckCircle className="text-white h-5 w-5" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">견적조건 추출기 <span className="font-medium text-slate-500 text-sm ml-1">Data Extractor</span></h1>
          </div>

          {headerTradeText && (
            <div className="hidden sm:flex items-center gap-2 bg-blue-50 border border-blue-200 text-blue-800 px-4 py-1.5 rounded-full font-medium shadow-sm animate-in fade-in zoom-in">
              <MapPin className="w-4 h-4 text-blue-600" />
              <span className="text-blue-700/80 text-xs">검토 대상 공종</span>
              <span>{headerTradeText}</span>
            </div>
          )}

          <div className="text-sm font-medium text-slate-500 bg-slate-100 px-3 py-1 rounded-full">
            B2B SaaS Prototype
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-8">
        {/* Welcome Section */}
        <section className="mb-10 max-w-3xl">
          <h2 className="text-3xl font-bold text-slate-900 mb-2">견적조건(현장) DB화 전처리</h2>
          <p className="text-slate-600 text-lg">
            DB화를 원하는 여러 개의 워드 파일(.docx) 견적 조건을 동시에 드래그 앤 드롭해 주세요.<br />
            AI가 병합하여 문장 중복을 제거하고 체계적인 데이터베이스로 변환합니다.
          </p>
        </section>

        {/* Upload Section */}
        <section className="mb-12">
          {/* (Same as before drag and drop UI) */}
          <div
            className={`transition-all duration-200 border-2 border-dashed rounded-xl p-12 text-center flex flex-col items-center justify-center bg-white shadow-sm mb-6
              ${isDragging ? "border-blue-500 bg-blue-50 scale-[1.01]" : "border-slate-300 hover:border-slate-400"}
            `}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <input
              type="file"
              accept=".docx"
              multiple
              className="hidden"
              ref={fileInputRef}
              onChange={handleFileInput}
            />

            <div className="flex flex-col items-center gap-4 cursor-pointer" onClick={() => fileInputRef.current?.click()}>
              <div className={`h-16 w-16 rounded-full flex items-center justify-center transition-colors ${isDragging ? "bg-blue-200 text-blue-700" : "bg-slate-100 text-slate-500"}`}>
                <UploadCloud className="h-8 w-8" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-slate-900 mb-1">여기로 파일 여러 개를 한 번에 드래그 앤 드롭하세요</h3>
                <p className="text-slate-500 text-sm">또는 클릭하여 내 PC에서 여러 파일 선택 (.docx 지원)</p>
              </div>
            </div>
          </div>

          {/* Selected Files Preview Panel */}
          {/* Selected Files Preview Panel */}
          {scanQueue.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden mb-8 animate-in fade-in slide-in-from-top-4">
              <div className="px-6 py-4 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-slate-800">분석 대기열 구성 중</h3>
                  <p className="text-xs text-slate-500 mt-0.5">총 <span className="font-bold text-blue-600">{scanQueue.length}</span> 건의 문서가 준비되었습니다.</p>
                </div>
                <div className="flex flex-col gap-2">
                  <div className="flex gap-3">
                  <button
                    onClick={clearFiles}
                    className="px-4 py-2 text-sm font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors"
                  >
                    초기화
                  </button>
                  <button
                    onClick={processFile}
                    disabled={!isProcessing && !scanQueue.some(q => q.isSelected && !q.isAnalyzed)}
                    className={`flex items-center gap-2 px-6 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-70 disabled:cursor-not-allowed shadow-sm transition-colors ${
                      isProcessing ? "bg-red-600 hover:bg-red-700" : "bg-blue-600 hover:bg-blue-700"
                    }`}
                  >
                    {isProcessing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {isProcessing ? "1단계 분석 중단" : "견적조건 추출 (1단계)"}
                  </button>
                  <button
                    onClick={() => {
                      if (fullAnalysisDisabledReason) return;
                      runFullAnalysis();
                    }}
                    aria-disabled={!!fullAnalysisDisabledReason}
                    style={{ backgroundColor: "#2563eb", color: "#ffffff", opacity: 1 }}
                    className={`flex items-center gap-2 px-6 py-2 text-sm font-semibold tracking-tight text-white bg-blue-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-300 shadow-sm transition-colors ${
                      fullAnalysisDisabledReason ? "cursor-not-allowed" : "hover:bg-blue-700"
                    }`}
                  >
                    {isRunningFullAnalysis ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {isRunningFullAnalysis ? "원클릭 전체 분석 진행 중..." : "원클릭 분석 (1~3단계)"}
                  </button>
                  </div>
                  {fullAnalysisDisabledReason && (
                    <p className="text-xs text-slate-500 pl-1">{fullAnalysisDisabledReason}</p>
                  )}
                </div>
              </div>

              <ul className="max-h-[300px] overflow-y-auto divide-y divide-slate-100 px-2">
                {scanQueue.map((item) => (
                  <li key={item.id} className={`flex items-center justify-between py-3 px-4 hover:bg-slate-50 group transition-colors rounded-lg ${item.isAnalyzed ? 'opacity-60 bg-slate-50' : ''}`}>
                    <div className="flex items-center gap-3 overflow-hidden flex-1">
                      <input
                        type="checkbox"
                        checked={item.isSelected}
                        onChange={() => toggleSelect(item.id)}
                        className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer disabled:opacity-50"
                        disabled={item.isAnalyzed || isProcessing}
                      />
                      <div className={`h-10 w-10 rounded-lg flex items-center justify-center shrink-0 ${item.isAnalyzed ? 'bg-green-50 text-green-500' : 'bg-blue-50 text-blue-500'}`}>
                        {item.isAnalyzed ? <CheckCircle className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
                      </div>
                      <div className="truncate py-1 flex-1">
                        <p className={`text-sm font-medium truncate ${item.isAnalyzed ? 'line-through text-slate-500' : 'text-slate-800'}`}>{item.file.name}</p>
                        <p className="text-xs text-slate-400 flex items-center gap-2">
                          <span>{(item.file.size / 1024).toFixed(1)} KB</span>
                          {item.isScanning ? (
                            <span className="flex items-center text-blue-400 gap-1"><Loader2 className="h-3 w-3 animate-spin" />글자 수 확인 중...</span>
                          ) : item.length ? (
                            <span className="text-slate-500">· 텍스트: {item.length.toLocaleString()} 자</span>
                          ) : (
                            <span className="text-red-400">· 읽기 실패</span>
                          )}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {item.length && item.length > 30000 && !item.isAnalyzed && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-700 border border-amber-200 uppercase tracking-wider">
                          ⚠️ 방대함 (AI 부하위험)
                        </span>
                      )}

                      <button
                        onClick={() => removeScanItem(item.id)}
                        disabled={isProcessing}
                        className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors opacity-0 group-hover:opacity-100 disabled:hidden"
                        title="제외"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Processing Indicator (1~3단계 및 원클릭 공통) */}
          {anyAnalysisBusy && (
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-6 flex flex-col items-center justify-center animate-in fade-in slide-in-from-bottom-4">
              <div className="flex items-center gap-4 mb-2">
                <div className="flex h-11 w-11 shrink-0 text-slate-600 items-center justify-center rounded-full border border-slate-200 bg-white shadow-sm">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-slate-800">분석 진행 중</h3>
                  {busyPhaseLabel ? (
                    <p className="text-slate-500 text-sm mt-0.5">{busyPhaseLabel}</p>
                  ) : null}
                  <p className="text-xs text-slate-400 tabular-nums mt-1">
                    경과 {formatElapsedClock(liveElapsedMs)}
                  </p>
                  {progressStatus ? (
                    <p className="text-slate-600 text-sm mt-2 leading-snug">{progressStatus}</p>
                  ) : null}
                </div>
              </div>

              <div className="w-full max-w-md bg-slate-200/80 h-1.5 rounded-full overflow-hidden mt-5">
                <div className="bg-slate-500 w-1/3 h-full animate-[progress_2s_ease-in-out_infinite]"></div>
              </div>
            </div>
          )}
        </section>

        {/* Results Section */}
        {results && (
          <section className="animate-in fade-in slide-in-from-bottom-8">
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
              <div className="p-6 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center justify-between gap-4 bg-slate-50">
                <div className="flex flex-col gap-2">
                  <h3 className="text-xl font-bold flex items-center gap-2 text-slate-900">
                    <CheckCircle className="h-5 w-5 text-green-500" />
                    분석 완료
                  </h3>
                  <div className="flex items-center gap-3">
                    <p className="text-sm text-slate-500">총 <span className="font-semibold text-slate-900">{results.length}</span>개 추출</p>
                    <span className="text-slate-300">|</span>
                    <p className="text-sm text-slate-500">중복 <span className="font-semibold text-red-500 tabular-nums">{String(duplicatesResults.length).padStart(3, "0")}</span>개</p>
                  </div>
                  {durationSummaryLine ? (
                    <p className="text-xs text-slate-400 mt-1 tabular-nums">{durationSummaryLine}</p>
                  ) : null}
                </div>

                {/* Tabs */}
                <div className="flex bg-slate-200/60 p-1 rounded-lg">
                  <button
                    onClick={() => setActiveTab('all')}
                    className={`flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md transition-all min-h-[56px] min-w-[170px] text-center leading-tight ${activeTab === 'all' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                  >
                    <span className="flex flex-col items-center">
                      <span>전체 리스트 추출</span>
                      <span className="text-xs">(1단계)</span>
                    </span>
                  </button>
                  <button
                    onClick={() => setActiveTab('duplicates')}
                    className={`flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md transition-all min-h-[56px] min-w-[170px] text-center leading-tight ${activeTab === 'duplicates' ? 'bg-white text-emerald-700 shadow-sm ring-1 ring-emerald-500/50' : 'text-slate-500 hover:text-slate-700'}`}
                  >
                    <Copy className="h-4 w-4 shrink-0 text-emerald-500" />
                    <span className="flex flex-col items-center">
                      <span>분류화 작업</span>
                      <span className="text-xs">(2단계)</span>
                    </span>
                  </button>
                  <button
                    onClick={() => setActiveTab('deep_review')}
                    className={`flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md transition-all min-h-[56px] min-w-[170px] text-center leading-tight ${activeTab === 'deep_review' ? 'bg-white text-purple-700 shadow-sm ring-1 ring-purple-500/50' : 'text-slate-500 hover:text-slate-700'}`}
                  >
                    <Search className="h-4 w-4 shrink-0 text-purple-500" />
                    <span className="flex flex-col items-center">
                      <span>심층 분석</span>
                      <span className="text-xs">(3단계)</span>
                    </span>
                  </button>
                </div>

                <div className="flex items-center gap-3 flex-wrap">
                  <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-3 py-1.5 shadow-sm hover:border-slate-300 transition-colors">
                    <Filter className="h-4 w-4 text-slate-400" />
                    <select
                      className="text-sm font-medium bg-transparent border-none focus:ring-0 text-slate-700 cursor-pointer outline-none"
                      value={filterTrade}
                      onChange={(e) => setFilterTrade(e.target.value)}
                    >
                      <option value="All">공종명 (전체)</option>
                      {uniqueTrades.map(trade => (
                        <option key={trade} value={trade}>{trade}</option>
                      ))}
                    </select>
                  </div>

                  <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-3 py-1.5 shadow-sm hover:border-slate-300 transition-colors">
                    <Filter className="h-4 w-4 text-slate-400" />
                    <select
                      className="text-sm font-medium bg-transparent border-none focus:ring-0 text-slate-700 cursor-pointer outline-none"
                      value={filterMajor}
                      onChange={(e) => setFilterMajor(e.target.value)}
                    >
                      <option value="All">대분류 (전체)</option>
                      {uniqueMajors.map(major => (
                        <option key={major} value={major}>{major}</option>
                      ))}
                    </select>
                  </div>

                  <div className="flex items-center gap-2 ml-2">
                    <button
                      onClick={downloadCSV}
                      className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors shadow-sm"
                    >
                      <Download className="h-4 w-4" />
                      CSV
                    </button>
                    <button
                      onClick={downloadExcel}
                      className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 transition-colors shadow-sm"
                    >
                      <Download className="h-4 w-4" />
                      EXCEL
                    </button>
                  </div>
                </div>
              </div>

              {activeTab === 'deep_review' && (Object.keys(generalReviews).length > 0 || Object.keys(legalReviews).length > 0) && (
                <div className="px-6 py-3 border-b border-slate-200 bg-white flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-semibold text-slate-500 mr-1">법률 리스크 필터</span>
                  <button onClick={() => setDeepRiskFilter("all")} className={`px-2.5 py-1 text-xs rounded-full border ${deepRiskFilter === "all" ? "bg-slate-800 text-white border-slate-800" : "bg-white text-slate-600 border-slate-300"}`}>전체</button>
                  <button onClick={() => setDeepRiskFilter("red")} className={`px-2.5 py-1 text-xs rounded-full border ${deepRiskFilter === "red" ? "bg-red-600 text-white border-red-600" : "bg-white text-red-600 border-red-200"}`}>🔴 {deepRiskCounts.red}개</button>
                  <button onClick={() => setDeepRiskFilter("yellow")} className={`px-2.5 py-1 text-xs rounded-full border ${deepRiskFilter === "yellow" ? "bg-yellow-500 text-white border-yellow-500" : "bg-white text-yellow-700 border-yellow-200"}`}>🟡 {deepRiskCounts.yellow}개</button>
                  <button onClick={() => setDeepRiskFilter("green")} className={`px-2.5 py-1 text-xs rounded-full border ${deepRiskFilter === "green" ? "bg-green-600 text-white border-green-600" : "bg-white text-green-700 border-green-200"}`}>🟢 {deepRiskCounts.green}개</button>

                  <span className="text-xs font-semibold text-slate-500 ml-3 mr-1">표준(일반)조건 필터</span>
                  <button onClick={() => setDeepGeneralFilter("all")} className={`px-2.5 py-1 text-xs rounded-full border ${deepGeneralFilter === "all" ? "bg-slate-800 text-white border-slate-800" : "bg-white text-slate-600 border-slate-300"}`}>전체</button>
                  <button onClick={() => setDeepGeneralFilter("완전중복")} className={`px-2.5 py-1 text-xs rounded-full border ${deepGeneralFilter === "완전중복" ? "bg-blue-600 text-white border-blue-600" : "bg-white text-blue-700 border-blue-200"}`}>완전중복 {deepGeneralCounts.full}개</button>
                  <button onClick={() => setDeepGeneralFilter("부분중복")} className={`px-2.5 py-1 text-xs rounded-full border ${deepGeneralFilter === "부분중복" ? "bg-orange-500 text-white border-orange-500" : "bg-white text-orange-700 border-orange-200"}`}>부분중복 {deepGeneralCounts.partial}개</button>
                  <button onClick={() => setDeepGeneralFilter("신규(고유)")} className={`px-2.5 py-1 text-xs rounded-full border ${deepGeneralFilter === "신규(고유)" ? "bg-slate-600 text-white border-slate-600" : "bg-white text-slate-700 border-slate-300"}`}>신규(고유) {deepGeneralCounts.unique}개</button>

                  <span className="text-xs font-semibold text-slate-500 ml-3 mr-1">내보내기 선택</span>
                  <button
                    onClick={() =>
                      setDeepSelectedMap((prev) => {
                        const next = { ...prev };
                        deepReviewRows.forEach(({ idxStr }) => {
                          next[idxStr] = true;
                        });
                        return next;
                      })
                    }
                    className="px-2.5 py-1 text-xs rounded-full border bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
                  >
                    전체 체크
                  </button>
                  <button
                    onClick={() =>
                      setDeepSelectedMap((prev) => {
                        const next = { ...prev };
                        deepReviewRows.forEach(({ idxStr }) => {
                          next[idxStr] = false;
                        });
                        return next;
                      })
                    }
                    className="px-2.5 py-1 text-xs rounded-full border bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
                  >
                    전체 해제
                  </button>
                  <span className="text-xs text-slate-500">
                    체크됨 {selectedVisibleDeepCount}/{deepReviewRows.length}
                  </span>
                </div>
              )}

              {/* Data Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm text-slate-600 border-collapse">
                  <thead className="bg-slate-50 text-xs uppercase text-slate-500 font-semibold border-b border-slate-200">
                    <tr>
                      {activeTab === 'deep_review' && (
                        <th scope="col" className="px-4 py-4 whitespace-nowrap text-center w-[70px]">
                          <input
                            type="checkbox"
                            checked={isAllVisibleDeepChecked}
                            onChange={(e) =>
                              setDeepSelectedMap((prev) => {
                                const next = { ...prev };
                                deepReviewRows.forEach(({ idxStr }) => {
                                  next[idxStr] = e.target.checked;
                                });
                                return next;
                              })
                            }
                            title="현재 필터 결과 전체 선택"
                            className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                          />
                        </th>
                      )}
                      {activeTab === 'duplicates' && <th scope="col" className="px-6 py-4 whitespace-nowrap text-center text-red-600">중복 발견 (Count)</th>}
                      {(activeTab === 'duplicates' || activeTab === 'deep_review') && <th scope="col" className="px-6 py-4 whitespace-nowrap w-[100px]">공종명</th>}
                      <th scope="col" className="px-6 py-4 whitespace-nowrap w-[120px]">대분류</th>
                      {activeTab === 'all' && <th scope="col" className="px-6 py-4 whitespace-nowrap w-[120px]">중분류</th>}
                      {(activeTab === 'all' || activeTab === 'deep_review') && <th scope="col" className="px-6 py-4 whitespace-nowrap w-[150px]">소분류</th>}
                      <th scope="col" className="px-6 py-4 min-w-[300px] w-auto">
                        {activeTab === 'all' ? '견적 조건 원문 (내용)' : activeTab === 'duplicates' ? '현장별 문구 비교' : '원본 내용 및 대체 문구 검토'}
                      </th>
                      {activeTab === 'all' && <th scope="col" className="px-6 py-4 whitespace-nowrap w-[150px]">출처(현장명)</th>}
                      {activeTab === 'deep_review' && <th scope="col" className="px-6 py-4 whitespace-nowrap w-[200px]">진단 결과</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {activeTab === 'all' ? (
                      // === ALL TAB ===
                      filteredResults.length > 0 ? (
                        filteredResults.map((row, index) => (
                          <tr key={index} className="hover:bg-slate-50/50 transition-colors">
                            <td className="px-6 py-4 whitespace-nowrap align-top">
                              <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-600">
                                {row.trade || '1차 추출 완료'}
                              </span>
                            </td>
                            <td className="px-6 py-4 font-medium text-slate-400 whitespace-nowrap align-top">{row.majorCategory || 'AI 분석 대기...'}</td>
                            <td className="px-6 py-4 text-slate-400 whitespace-nowrap align-top">{row.middleCategory || '-'}</td>
                            <td className="px-6 py-4 text-slate-400 min-w-[150px] align-top">{row.minorCategory || '-'}</td>
                            <td className="px-6 py-4 leading-relaxed text-slate-900 whitespace-pre-wrap break-keep align-top max-w-xl">{row.content}</td>
                            <td className="px-6 py-4 text-xs text-slate-500 break-keep min-w-[150px] align-top" title={row.sourceFile}>{row.sourceFile || '-'}</td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={6} className="px-6 py-12 text-center text-slate-500">
                            <div className="flex flex-col items-center justify-center">
                              <Search className="h-8 w-8 text-slate-300 mb-2" />
                              <p>필터 조건에 맞는 데이터가 없습니다.</p>
                            </div>
                          </td>
                        </tr>
                      )
                    ) : activeTab === 'duplicates' ? (
                      // === DUPLICATES TAB ===
                      duplicatesResults.length > 0 ? (
                        duplicatesResults.map((row, index) => (
                          <tr key={index} className="hover:bg-red-50/20 transition-colors">
                            <td className="px-6 py-4 text-center align-top whitespace-nowrap">
                              <span className="inline-flex items-center px-2.5 py-1 rounded-md text-sm font-bold bg-red-100 text-red-700">
                                {row.count}건
                              </span>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap align-top">
                              <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-600">
                                {row.trade}
                              </span>
                            </td>
                            <td className="px-6 py-4 font-medium text-slate-500 whitespace-nowrap align-top">{row.majorCategory}</td>
                            <td className="px-6 py-4 text-slate-500 font-semibold align-top">{row.minorCategory}</td>
                            <td className="px-6 py-4 align-top w-full">
                              <ul className="space-y-4">
                                {row.variations.map((v: DuplicateVariation, i: number) => (
                                  <li key={i} className="flex flex-col gap-1 border-b border-slate-100 last:border-0 pb-3 last:pb-0">
                                    <span className="text-xs font-medium text-rose-600 bg-rose-50 inline-block px-2.5 py-1 rounded-md w-fit">📍 {v.sourceFile}</span>
                                    <span className="text-sm text-slate-700 leading-relaxed pt-1.5">{v.content}</span>
                                  </li>
                                ))}
                              </ul>
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={6} className="px-6 py-20 text-center">
                            <div className="flex flex-col items-center justify-center max-w-md mx-auto">
                              <div className="h-16 w-16 bg-emerald-50 rounded-full flex items-center justify-center mb-4">
                                <Copy className="h-8 w-8 text-emerald-500" />
                              </div>
                              <h3 className="text-lg font-bold text-slate-800 mb-2">중복화 및 카테고리화</h3>
                              <p className="text-slate-500 text-sm mb-8 leading-relaxed">
                                1단계에서 추출된 전체 조건문들을 AI가 다시 한 번 스캔하여, 같은 의미와 목적을 가진 조건들을 그룹화하고 대/중/소 카테고리를 추론 체계화합니다.
                              </p>
                              <button
                                onClick={() => { void processDuplicates(); }}
                                className={`flex items-center gap-2 px-8 py-3 font-semibold text-white rounded-xl disabled:opacity-70 disabled:cursor-not-allowed shadow-md transition-all hover:-translate-y-0.5 ${
                                  isAnalyzingDuplicates
                                    ? "bg-red-600 hover:bg-red-700 shadow-red-600/20"
                                    : "bg-emerald-600 hover:bg-emerald-700 shadow-emerald-600/20"
                                }`}
                              >
                                {isAnalyzingDuplicates ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
                                {isAnalyzingDuplicates ? "2단계 분석 중단" : "✨ 스마트 분석 시작"}
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    ) : (
                      // === DEEP REVIEW TAB ===
                      duplicatesResults.length > 0 && (Object.keys(generalReviews).length > 0 || Object.keys(legalReviews).length > 0) ? (
                        deepReviewRows.length > 0 ? (
                          deepReviewRows.map(({ row, index, idxStr, gReview, lReview }) => {

                          return (
                            <tr key={index} className="hover:bg-purple-50/20 transition-colors">
                              <td className="px-4 py-4 text-center align-top">
                                <input
                                  type="checkbox"
                                  checked={!!deepSelectedMap[idxStr]}
                                  onChange={(e) =>
                                    setDeepSelectedMap((prev) => ({
                                      ...prev,
                                      [idxStr]: e.target.checked,
                                    }))
                                  }
                                  className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                                />
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap align-top">
                                <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-600">
                                  {row.trade}
                                </span>
                              </td>
                              <td className="px-6 py-4 font-medium text-slate-500 whitespace-nowrap align-top">{row.majorCategory}</td>
                              <td className="px-6 py-4 text-slate-500 font-semibold align-top">{row.minorCategory}</td>
                              
                              <td className="px-6 py-4 align-top w-full">
                                <div className="p-3 bg-white border border-slate-200 rounded-lg shadow-sm mb-3">
                                  {(() => {
                                    const originalText = row.variations[0]?.content || "";
                                    const appliedText = lReview?.suggestedFix || "";
                                    const isApplied = !!appliedSuggestedFixMap[idxStr] && !!appliedText.trim();
                                    const parts = isApplied ? getWordDiffParts(originalText, appliedText) : [];

                                    if (!isApplied) {
                                      return <p className="text-sm font-medium text-slate-800 leading-relaxed">{originalText}</p>;
                                    }

                                    return (
                                      <p className="text-sm font-medium leading-relaxed whitespace-pre-wrap break-keep">
                                        {parts.map((part, i) => (
                                          <span
                                            key={`${idxStr}-${i}`}
                                            className={
                                              part.type === "remove"
                                                ? "line-through text-slate-400"
                                                : part.type === "add"
                                                  ? "text-blue-700 font-semibold"
                                                  : "text-slate-800"
                                            }
                                          >
                                            {part.text}{" "}
                                          </span>
                                        ))}
                                      </p>
                                    );
                                  })()}
                                </div>
                                
                                {lReview && lReview.suggestedFix && (
                                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg shadow-sm">
                                    <div className="flex items-center justify-between mb-2">
                                      <p className="text-xs font-bold text-amber-800">💡 AI 모범 대체 문구 제안 (수정 조치)</p>
                                      <button
                                        onClick={() => openReviseClauseModal(index, row.variations[0]?.content || "", lReview)}
                                        className="px-2 py-1 bg-white border border-amber-300 text-amber-700 text-xs font-medium rounded hover:bg-amber-100 transition-colors flex items-center gap-1"
                                      >
                                        문구 적용하기
                                      </button>
                                    </div>
                                    {isSuggestedFixEdited(idxStr) && (
                                      <div className="mb-2 rounded-md border border-slate-200 bg-white p-2">
                                        <p className="text-[10px] font-bold text-slate-500 mb-1">초기 AI 추천 문구</p>
                                        <p className="text-xs text-slate-600 whitespace-pre-wrap">
                                          {initialLegalReviews[idxStr]?.suggestedFix || "-"}
                                        </p>
                                      </div>
                                    )}
                                    <p className="text-sm text-slate-700 leading-relaxed">{lReview.suggestedFix}</p>
                                    <div className="mt-2">
                                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${isSuggestedFixEdited(idxStr) ? "bg-blue-100 text-blue-700" : "bg-slate-200 text-slate-700"}`}>
                                        {isSuggestedFixEdited(idxStr) ? "수정문구 반영됨" : "AI 원문 유지"}
                                      </span>
                                    </div>
                                  </div>
                                )}
                              </td>
                              
                              <td className="px-6 py-4 whitespace-nowrap align-top max-w-[250px]">
                                <div className="flex flex-col gap-2">
                                  {gReview && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setGeneralConditionDetailModal({
                                          matchType: gReview.matchType,
                                          explanation: gReview.explanation,
                                          matchedGeneralClause: gReview.matchedGeneralClause,
                                          siteClauseContent:
                                            gReview.content ||
                                            row.variations[0]?.content ||
                                            "",
                                        })
                                      }
                                      className="flex flex-col gap-1 p-2 rounded-lg border bg-slate-50 border-slate-200 text-left w-full hover:bg-blue-50/80 hover:border-blue-200 transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-300"
                                      title="클릭하여 표준 일반조건 대조 상세 보기"
                                    >
                                      <span className={`text-xs font-bold w-fit px-2 py-0.5 rounded-full ${gReview.matchType === '완전중복' ? 'bg-blue-100 text-blue-700' : gReview.matchType === '신규(고유)' ? 'bg-slate-200 text-slate-700' : 'bg-orange-100 text-orange-700'}`}>
                                        표준: {gReview.matchType}
                                      </span>
                                      <span className="text-[10px] text-slate-500 whitespace-normal line-clamp-3">
                                        {gReview.explanation}
                                      </span>
                                      <span className="text-[10px] text-blue-600 font-medium pt-0.5">
                                        클릭하여 표준 조항·근거 전체 보기 →
                                      </span>
                                    </button>
                                  )}
                                  
                                  {lReview && (
                                    <div className="flex flex-col gap-1 p-2 rounded-lg border bg-slate-50 border-slate-200 mt-1">
                                      <span className={`text-xs font-bold w-fit px-2 py-0.5 rounded-full ${lReview.riskLevel.includes('Red') || lReview.riskLevel.includes('위반') ? 'bg-red-100 text-red-700' : lReview.riskLevel.includes('Yellow') || lReview.riskLevel.includes('주의') ? 'bg-yellow-100 text-yellow-700' : 'bg-green-100 text-green-700'}`}>
                                        법률: {lReview.riskLevel.split(' ')[0]}
                                      </span>
                                      <button
                                        onClick={() =>
                                          setRiskDetailModal({
                                            riskLevel: lReview.riskLevel,
                                            violatedLaw: lReview.violatedLaw,
                                            riskDescription: lReview.riskDescription,
                                          })
                                        }
                                        className="text-left text-[10px] text-slate-500 whitespace-normal line-clamp-3 hover:text-slate-700 underline underline-offset-2"
                                        title="클릭하여 위반 사유 전체 보기"
                                      >
                                        {lReview.riskDescription}
                                      </button>
                                    </div>
                                  )}
                                  
                                  {gReview?.matchType === '완전중복' && (
                                    <button className="mt-2 w-full px-2 py-1.5 text-xs text-red-600 border border-red-200 rounded hover:bg-red-50 font-medium">
                                      중복 삭제
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                          })
                        ) : (
                          <tr>
                            <td colSpan={7} className="px-6 py-12 text-center text-slate-500">
                              <div className="flex flex-col items-center justify-center">
                                <Search className="h-8 w-8 text-slate-300 mb-2" />
                                <p>선택한 진단 결과 필터에 맞는 항목이 없습니다.</p>
                              </div>
                            </td>
                          </tr>
                        )
                      ) : (
                        <tr>
                          <td colSpan={7} className="px-6 py-20 text-center">
                            <div className="flex flex-col items-center justify-center max-w-md mx-auto">
                              <div className="h-16 w-16 bg-purple-50 rounded-full flex items-center justify-center mb-4">
                                <Search className="h-8 w-8 text-purple-500" />
                              </div>
                              <h3 className="text-lg font-bold text-slate-800 mb-2">3단계 심층 분석 및 법적 리스크 진단</h3>
                              <p className="text-slate-500 text-sm mb-8 leading-relaxed">
                                AI가 추출된 현장별 주요 계약조건을 공종별 표준/일반조건과 대조하고, 하도급법 및 기본법령을 기반으로 법적 위반 리스크를 점검합니다.
                              </p>
                              <button
                                onClick={() => { void processDeepReview(); }}
                                className={`flex items-center gap-2 px-8 py-3 font-semibold text-white rounded-xl disabled:opacity-70 disabled:cursor-not-allowed shadow-md transition-all hover:-translate-y-0.5 ${
                                  isDeepReviewing
                                    ? "bg-red-600 hover:bg-red-700 shadow-red-600/20"
                                    : "bg-purple-600 hover:bg-purple-700 shadow-purple-600/20"
                                }`}
                              >
                                {isDeepReviewing ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
                                {isDeepReviewing ? "3단계 분석 중단" : "⚖️ 심층 분석 시작"}
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}
      </main>

      {revisionTarget && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-2xl rounded-xl bg-white shadow-2xl border border-slate-200">
            <div className="px-6 py-4 border-b border-slate-200">
              <h3 className="text-lg font-bold text-slate-900">AI 추천 문구 편집</h3>
              <p className="text-sm text-slate-500 mt-1">
                AI가 추천한 문구가 자동으로 채워져 있습니다. 필요하면 수정 후 저장하세요.
              </p>
            </div>

            <div className="px-6 py-4 space-y-3">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs font-semibold text-slate-600 mb-1">원문</p>
                <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                  {revisionTarget.originalContent || "-"}
                </p>
              </div>

              <label className="block">
                <span className="text-sm font-medium text-slate-700">
                  AI 재생성 요청사항
                </span>
                <textarea
                  value={reviseRequestText}
                  onChange={(e) => setReviseRequestText(e.target.value)}
                  rows={3}
                  className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 resize-y"
                  placeholder={"예: 지급 조건은 유지하고 책임 범위 문구만 더 명확히 수정"}
                />
              </label>

              <label className="block">
                <span className="text-sm font-medium text-slate-700">
                  수정 문구
                </span>
                <textarea
                  value={editedSuggestedFix}
                  onChange={(e) => setEditedSuggestedFix(e.target.value)}
                  rows={6}
                  className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 resize-y"
                  placeholder={"AI 추천 문구가 자동 입력됩니다. 필요한 부분만 보완해 저장하세요."}
                />
              </label>
              <p className="text-xs text-slate-500">
                "AI 재생성"으로 새 제안을 받아보고, 저장하면 해당 항목의 "AI 모범 대체 문구 제안" 텍스트가 즉시 업데이트됩니다.
              </p>
              {regenerateError && (
                <p className="text-xs text-red-600">{regenerateError}</p>
              )}
            </div>

            <div className="px-6 py-4 border-t border-slate-200 flex items-center justify-end gap-2">
              <button
                onClick={closeReviseClauseModal}
                className="px-4 py-2 text-sm font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors"
              >
                취소
              </button>
              <button
                onClick={() => { void regenerateSuggestedFix(); }}
                disabled={isRegeneratingFix}
                className="px-4 py-2 text-sm font-semibold text-amber-800 bg-amber-100 border border-amber-300 rounded-lg hover:bg-amber-200 transition-colors flex items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {isRegeneratingFix ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {isRegeneratingFix ? "AI 재생성 중..." : "AI 재생성"}
              </button>
              <button
                onClick={saveEditedSuggestedFix}
                className="px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2"
              >
                저장
              </button>
            </div>
          </div>
        </div>
      )}

      {riskDetailModal && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/45 px-4">
          <div className="w-full max-w-xl rounded-xl bg-white shadow-2xl border border-slate-200">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900">법적 리스크 상세 사유</h3>
              <button
                onClick={() => setRiskDetailModal(null)}
                className="px-2 py-1 text-xs font-medium text-slate-600 bg-slate-100 rounded hover:bg-slate-200"
              >
                닫기
              </button>
            </div>
            <div className="px-6 py-4 space-y-3">
              <div className="text-xs">
                <span className="font-semibold text-slate-600">진단:</span>{" "}
                <span className="text-slate-800">{riskDetailModal.riskLevel}</span>
              </div>
              <div className="text-xs">
                <span className="font-semibold text-slate-600">위반 근거:</span>{" "}
                <span className="text-slate-800">{riskDetailModal.violatedLaw || "-"}</span>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs font-semibold text-slate-600 mb-1">위반 사유 전체</p>
                <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-wrap break-keep">
                  {riskDetailModal.riskDescription}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {generalConditionDetailModal && (
        <div className="fixed inset-0 z-[111] flex items-center justify-center bg-black/45 px-4">
          <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl bg-white shadow-2xl border border-slate-200">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white">
              <h3 className="text-lg font-bold text-slate-900">표준 일반조건 대조 상세</h3>
              <button
                type="button"
                onClick={() => setGeneralConditionDetailModal(null)}
                className="px-2 py-1 text-xs font-medium text-slate-600 bg-slate-100 rounded hover:bg-slate-200"
              >
                닫기
              </button>
            </div>
            <div className="px-6 py-4 space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-slate-600">중복 진단:</span>
                <span
                  className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                    generalConditionDetailModal.matchType === "완전중복"
                      ? "bg-blue-100 text-blue-700"
                      : generalConditionDetailModal.matchType === "신규(고유)"
                        ? "bg-slate-200 text-slate-700"
                        : "bg-orange-100 text-orange-700"
                  }`}
                >
                  {generalConditionDetailModal.matchType}
                </span>
              </div>

              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs font-semibold text-slate-600 mb-1">현장 견적조건 원문 (검토 대상)</p>
                <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-wrap break-keep">
                  {generalConditionDetailModal.siteClauseContent || "(없음)"}
                </p>
              </div>

              <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-3">
                <p className="text-xs font-semibold text-blue-900 mb-1">
                  표준(일반)조건에서 대응하는 조항 발췌
                </p>
                <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-wrap break-keep">
                  {generalConditionDetailModal.matchedGeneralClause?.trim()
                    ? generalConditionDetailModal.matchedGeneralClause
                    : "AI가 일반조건 원문에서 직접 발췌하지 않았습니다. 아래 상세 설명을 참고하세요."}
                </p>
              </div>

              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <p className="text-xs font-semibold text-slate-600 mb-1">대조 근거·상세 설명</p>
                <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-wrap break-keep">
                  {generalConditionDetailModal.explanation || "-"}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Global simple keyframes for purely stylistic progress bar */}
      <style dangerouslySetInnerHTML={{
        __html: `
        @keyframes progress {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(200%); }
        }
      `}} />
    </div>
  );
}
