#!/usr/bin/env node
/**
 * 금융감독원 OpenDART 전자공시 MCP 서버
 *
 * 공정위 가맹사업 MCP(../ftc-franchise)와 같은 틀이다. 키는 윈도우 사용자 환경변수 DART_API_KEY.
 *
 * RealYoungk/opendart-mcp 와 다른 점 (2026-10-30 소스 대조):
 *  - 회사 찾기: 그쪽 get_corp_code 는 전체 회사목록 ZIP 을 base64 로 통째 돌려줘서 Claude 가 못 읽는다.
 *    여기서는 ZIP 을 PC 에 받아 풀고 이름·종목코드로 검색한다. 모든 도구가 회사명을 그대로 받는다.
 *  - 공시 원문: 그쪽 get_document 도 ZIP base64 다. 여기서는 풀어서 본문 글자로 돌려준다
 *    (감사보고서만 내는 비상장 가맹본부의 재무제표를 읽는 유일한 길).
 *  - 그쪽 장점인 83개 API 전부는 dart_list_apis + dart_call_api 로 닿는다 (src/catalog.ts).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { createServer } from "http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { inflateRawSync } from "zlib";
import { z } from "zod";
import { DART_APIS } from "./catalog.js";

// ── 설정 ──────────────────────────────────────────────────────────────────────
const VERSION = "1.0.0";
const BASE = "https://opendart.fss.or.kr/api";
const CACHE_DIR = join(process.env.LOCALAPPDATA ?? tmpdir(), "opendart-mcp"); // Render 는 LOCALAPPDATA 가 없다
const CORP_CACHE = join(CACHE_DIR, "corpCode.json");
const CORP_TTL_MS = 7 * 24 * 3600_000; // 신규 등록 회사가 늦게 보이지 않도록 1주마다 새로 받는다

// Claude 앱이 키 등록 전에 켜졌으면 process.env 에 키가 없다. 레지스트리에서 직접 읽어 재시작 없이 쓴다.
let cachedKey: string | null = null;
function apiKey(): string {
  if (cachedKey) return cachedKey;
  let k = process.env.DART_API_KEY ?? "";
  if (!k && process.platform === "win32") {
    try {
      const out = execFileSync("reg", ["query", "HKCU\\Environment", "/v", "DART_API_KEY"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      k = out.match(/DART_API_KEY\s+REG_\w+\s+(\S+)/)?.[1] ?? "";
    } catch {
      /* 값이 없으면 reg 가 실패한다 */
    }
  }
  if (!k) throw new Error("DART_API_KEY 환경변수가 설정되지 않았습니다. set-dart-key.ps1 을 실행해 등록하세요.");
  cachedKey = k.trim();
  return cachedKey;
}

// ── DART 상태코드 ─────────────────────────────────────────────────────────────
const STATUS_MSG: Record<string, string> = {
  "010": "등록되지 않은 키입니다. opendart.fss.or.kr 에서 키를 확인하고 set-dart-key.ps1 로 다시 등록하세요.",
  "011": "사용할 수 없는 키입니다 (일시 중지 등). opendart.fss.or.kr > 인증키 관리에서 상태를 확인하세요.",
  "012": "접근할 수 없는 IP 입니다. 인증키에 등록된 IP 를 확인하세요.",
  "014": "파일이 존재하지 않습니다 (원문이 아직 생성 전이거나 접수번호가 틀림).",
  "020": "하루 요청 한도(20,000건)를 넘었습니다. 자정 이후 다시 시도하세요.",
  "021": "한 번에 조회할 수 있는 회사 수(최대 100개)를 넘었습니다.",
  "100": "입력값이 잘못됐습니다.",
  "101": "부적절한 접근입니다.",
  "800": "OpenDART 시스템 점검 중입니다. 잠시 후 다시 시도하세요.",
  "900": "OpenDART 정의되지 않은 오류입니다.",
  "901": "개인정보 보유기간이 지나 사용할 수 없는 키입니다. 키를 새로 발급받으세요.",
};

class DartError extends Error {
  constructor(public status: string, public dartMsg: string, public ep: string) {
    super(`${ep}: ${STATUS_MSG[status] ?? dartMsg} (status ${status}: ${dartMsg})`);
    this.name = "DartError";
  }
}

// ── 공통 호출 ─────────────────────────────────────────────────────────────────
function buildUrl(ep: string, ext: "json" | "xml", params: Record<string, string>): string {
  const q = new URLSearchParams({ crtfc_key: apiKey(), ...params });
  return `${BASE}/${ep}.${ext}?${q}`;
}

/** JSON API 호출. 013(조회된 데이터 없음)은 오류가 아니라 빈 결과로 돌려준다. */
async function dartJson(ep: string, params: Record<string, string>): Promise<any> {
  const resp = await fetch(buildUrl(ep, "json", params), { signal: AbortSignal.timeout(60_000) });
  const text = await resp.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${ep}: JSON 이 아닌 응답 (HTTP ${resp.status}): ${text.slice(0, 200)}`);
  }
  if (data.status === "013") return { ...data, list: [], empty: true };
  if (data.status !== "000") throw new DartError(String(data.status), String(data.message ?? ""), ep);
  return data;
}

/** ZIP 을 돌려주는 API 호출. 오류는 ZIP 대신 XML/JSON 상태 봉투로 온다. */
async function dartZip(ep: string, params: Record<string, string>): Promise<Buffer> {
  const resp = await fetch(buildUrl(ep, "xml", params), { signal: AbortSignal.timeout(120_000) });
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.readUInt32LE(0) === 0x04034b50) return buf; // "PK\3\4"
  const head = buf.subarray(0, 600).toString("utf8");
  const st = head.match(/<status>\s*(\d+)\s*<\/status>/)?.[1] ?? head.match(/"status"\s*:\s*"(\d+)"/)?.[1];
  const msg = head.match(/<message>\s*([^<]*)<\/message>/)?.[1] ?? head.match(/"message"\s*:\s*"([^"]*)"/)?.[1] ?? "";
  if (st) throw new DartError(st, msg, ep);
  throw new Error(`${ep}: ZIP 이 아닌 응답 (HTTP ${resp.status}): ${head.slice(0, 200)}`);
}

// 의존성을 늘리지 않으려고 직접 푼다. DART ZIP 은 저장(0)·deflate(8) 두 방식뿐이다.
function unzip(buf: Buffer): { name: string; data: Buffer }[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ZIP 목차를 찾지 못했습니다 (파일이 깨졌을 수 있음).");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: { name: string; data: Buffer }[] = [];
  for (let n = 0; n < count; n++) {
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compSize);
    out.push({ name, data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw) });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

// 오래된 공시는 EUC-KR 인데 XML 선언은 utf-8 이라고 거짓말한다 (삼성전자 2008 3분기 20081114000862).
// 선언을 믿지 말고 UTF-8 로 엄격히 풀어 보고, 깨지면 EUC-KR 로 읽는다.
function decodeXml(buf: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("euc-kr").decode(buf);
  }
}

// ── 회사 고유번호 목록 ────────────────────────────────────────────────────────
interface Corp { code: string; name: string; eng: string; stock: string; modified: string }
let corpList: Corp[] | null = null;
let corpLoadedAt = 0;

async function loadCorps(force = false): Promise<Corp[]> {
  if (!force && corpList) return corpList;
  if (!force && existsSync(CORP_CACHE) && Date.now() - statSync(CORP_CACHE).mtimeMs < CORP_TTL_MS) {
    corpList = JSON.parse(readFileSync(CORP_CACHE, "utf8"));
    corpLoadedAt = statSync(CORP_CACHE).mtimeMs;
    return corpList!;
  }
  const files = unzip(await dartZip("corpCode", {}));
  const xml = decodeXml(files[0].data);
  const list: Corp[] = [];
  const tag = (s: string, t: string) => (s.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1] ?? "").trim();
  for (const m of xml.matchAll(/<list>([\s\S]*?)<\/list>/g)) {
    list.push({
      code: tag(m[1], "corp_code"),
      name: tag(m[1], "corp_name"),
      eng: tag(m[1], "corp_eng_name"),
      stock: tag(m[1], "stock_code"),
      modified: tag(m[1], "modify_date"),
    });
  }
  if (list.length < 1000) throw new Error(`회사 목록이 비정상적으로 적습니다 (${list.length}건). 다시 시도하세요.`);
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CORP_CACHE, JSON.stringify(list));
  corpList = list;
  corpLoadedAt = Date.now();
  return list;
}

// "(주)교촌에프앤비", "교촌 에프앤비 주식회사" 가 같은 회사로 잡히도록 꾸밈말·공백을 뗀다
function norm(s: string): string {
  return s.toLowerCase().replace(/\(주\)|㈜|주식회사|\(유\)|유한회사|\s|\.|,/g, "");
}

function searchCorps(list: Corp[], query: string): Corp[] {
  const q = query.trim();
  if (/^\d{8}$/.test(q)) return list.filter(c => c.code === q);
  if (/^\d{6}$/.test(q)) {
    const byStock = list.filter(c => c.stock === q);
    if (byStock.length) return byStock;
  }
  const nq = norm(q);
  if (!nq) return [];
  const scored: { c: Corp; s: number }[] = [];
  for (const c of list) {
    const n = norm(c.name);
    const e = norm(c.eng);
    let s = 0;
    if (n === nq) s = 100;
    else if (n.startsWith(nq)) s = 60;
    else if (n.includes(nq)) s = 40;
    else if (e && e.includes(nq)) s = 30;
    if (!s) continue;
    if (c.stock) s += 10; // 같은 점수면 상장사를 위로
    scored.push({ c, s });
  }
  scored.sort((a, b) => b.s - a.s || a.c.name.length - b.c.name.length || b.c.modified.localeCompare(a.c.modified));
  return scored.map(x => x.c);
}

class AmbiguousCompany extends Error {
  constructor(public query: string, public candidates: Corp[]) {
    super(`'${query}' 에 해당하는 회사가 여러 곳입니다.`);
    this.name = "AmbiguousCompany";
  }
}

/** 회사명·종목코드(6자리)·고유번호(8자리) 무엇이든 받아 한 회사로 정한다. 애매하면 후보를 돌려준다. */
async function resolveCorp(input: string): Promise<Corp> {
  const q = input.trim();
  if (/^\d{8}$/.test(q)) {
    // 고유번호는 목록을 안 받아도 바로 쓸 수 있다
    const hit = corpList?.find(c => c.code === q);
    return hit ?? { code: q, name: q, eng: "", stock: "", modified: "" };
  }
  const found = searchCorps(await loadCorps(), q);
  if (!found.length) throw new Error(`'${q}' 와 일치하는 회사가 DART 에 없습니다. 이름 일부만 넣거나 dart_find_company 로 찾아보세요.`);
  const exact = found.filter(c => norm(c.name) === norm(q));
  // '삼성' 은 이름이 딱 맞는 비상장 '주식회사 삼성' 이 있다. 비슷한 이름의 상장사가 있으면 고르지 않고 묻는다.
  const listedOthers = found.some(c => c.stock && !exact.includes(c));
  if (exact.length === 1 && (exact[0].stock || !listedOthers)) return exact[0];
  if (found.length === 1) return found[0];
  throw new AmbiguousCompany(q, found.slice(0, 10));
}

function corpLine(c: Corp): string {
  return `${c.name} (고유번호 ${c.code}${c.stock ? `, 종목코드 ${c.stock}` : ", 비상장"})`;
}

// ── 출력 보조 ─────────────────────────────────────────────────────────────────
function toNum(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/,/g, "").trim();
  if (!s || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// DART 재무 API 금액은 원 단위다. 표에는 억원으로 줄여 보이고 json 은 원값 그대로 둔다.
function fmtWon(v: unknown): string {
  const n = toNum(v);
  if (n === null) return "-";
  const eok = n / 1e8;
  if (Math.abs(eok) >= 1) return `${eok.toLocaleString("ko-KR", { maximumFractionDigits: 1 })}억`;
  return `${Math.round(n / 1e4).toLocaleString("ko-KR")}만`;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function handleError(e: unknown) {
  let msg: string;
  if (e instanceof AmbiguousCompany) {
    msg = [
      `⚠️ ${e.message} 아래에서 골라 고유번호(8자리)로 다시 호출하세요.`,
      "",
      ...e.candidates.map(c => `- ${corpLine(c)}`),
    ].join("\n");
  } else if (e instanceof DartError) {
    msg = `⚠️ ${e.message}`;
  } else if (e instanceof Error) {
    msg = e.name === "TimeoutError" ? "⚠️ 응답 시간 초과. OpenDART 가 느린 상태일 수 있습니다." : `⚠️ ${e.message}`;
  } else {
    msg = `⚠️ 알 수 없는 오류: ${String(e)}`;
  }
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

const companySchema = z.string().min(1).max(100)
  .describe("회사명(일부도 됨, 예: '교촌에프앤비')·종목코드 6자리·고유번호 8자리 중 아무거나");
const reprtSchema = z.enum(["11011", "11012", "11013", "11014"]).default("11011")
  .describe("보고서: 11011 사업보고서(연간, 기본) · 11012 반기 · 11013 1분기 · 11014 3분기");
const fmtSchema = z.enum(["markdown", "json"]).default("markdown").describe("출력 형식");

const REPRT_NAME: Record<string, string> = { "11011": "사업보고서", "11012": "반기보고서", "11013": "1분기보고서", "11014": "3분기보고서" };
const PBLNTF_TY: Record<string, string> = {
  A: "정기공시", B: "주요사항보고", C: "발행공시", D: "지분공시", E: "기타공시",
  F: "외부감사관련", G: "펀드공시", H: "자산유동화", I: "거래소공시", J: "공정위공시",
};
const NO_FIN_HINT = [
  "",
  "> 재무 API 는 **사업보고서를 내는 회사**(상장사·일부 큰 비상장사)의 2015년 이후 자료만 있습니다.",
  "> 감사보고서만 내는 비상장사(가맹본부 대부분)는 여기 없으니 이렇게 하세요:",
  "> 1. `dart_search_disclosures` 에 `pblntf_ty=\"F\"`(외부감사관련)로 감사보고서를 찾고",
  "> 2. `dart_read_document` 에 그 접수번호와 `find=\"재무상태표\"` 또는 `\"손익계산서\"` 를 넣어 원문을 읽습니다.",
].join("\n");

// ── 공시 원문 캐시 (같은 문서를 쪽 넘길 때마다 다시 받지 않도록) ──────────────
const docCache = new Map<string, { at: number; files: { name: string; text: string }[] }>();

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

// 칸 안에 <P> 가 들어 있어 그냥 지우면 칸마다 줄이 갈린다. 표는 행 단위로 먼저 한 줄씩 만든다.
function xmlToText(xml: string): string {
  const inline = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  return xml
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<TR\b[^>]*>([\s\S]*?)<\/TR>/gi, (_, row: string) => {
      const cells = [...row.matchAll(/<(TD|TH|TE|TU)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map(m => inline(m[2]));
      return `\n${cells.join(" | ")}\n`;
    })
    .replace(/<\/(P|TITLE|BR|TABLE)\s*>|<BR\s*\/?>|<P\b[^>]*\/>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map(l => decodeEntities(l).replace(/[ \t ]+/g, " ").trim())
    .filter((l, i, a) => l || (i > 0 && a[i - 1]))
    .join("\n")
    .trim();
}

/** "재무상태표" 로 "재 무 상 태 표" 제목도 찾는다. 목차(점선)는 건너뛰고, 그 줄이 제목뿐인 곳을 먼저 고른다. */
function findHeading(text: string, find: string, from: number): number {
  const chars = [...find.replace(/\s+/g, "")].map(ch => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(chars.join("\\s*"), "g");
  re.lastIndex = from;
  let first = -1;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (/\.{5,}/.test(text.slice(m.index, m.index + m[0].length + 60))) continue; // 목차
    if (first < 0) first = m.index;
    const ls = text.lastIndexOf("\n", m.index) + 1;
    const le = text.indexOf("\n", m.index);
    const line = text.slice(ls, le < 0 ? undefined : le).trim();
    if (line.length <= m[0].length + 12) return m.index; // 제목 줄
  }
  return first;
}

async function loadDocument(rcept_no: string) {
  const hit = docCache.get(rcept_no);
  if (hit && Date.now() - hit.at < 3600_000) return hit.files;
  const files = unzip(await dartZip("document", { rcept_no }))
    .map(f => ({ name: f.name, text: xmlToText(decodeXml(f.data)) }));
  docCache.set(rcept_no, { at: Date.now(), files });
  if (docCache.size > 20) docCache.delete(docCache.keys().next().value!);
  return files;
}

// ── 서버 ──────────────────────────────────────────────────────────────────────
function createMcpServer() {
  const srv = new McpServer({ name: "opendart-mcp-server", version: VERSION });
  const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

// ── 도구 1: 회사 찾기 ─────────────────────────────────────────────────────────
  srv.registerTool(
  "dart_find_company",
  {
    title: "DART 회사 찾기",
    description:
      "회사명·영문명·종목코드로 DART 고유번호(8자리)를 찾습니다. 상장사뿐 아니라 감사보고서를 내는 비상장사도 나옵니다. " +
      "'(주)', '주식회사', 띄어쓰기는 무시합니다. 다른 도구는 회사명을 바로 받으므로 이 도구는 이름이 애매할 때 씁니다.",
    inputSchema: {
      query: z.string().min(1).max(100).describe("회사명 일부(예: '교촌'), 영문명, 종목코드 6자리, 고유번호 8자리"),
      listed_only: z.boolean().default(false).describe("true 면 상장사(종목코드 있는 곳)만"),
      limit: z.number().int().min(1).max(100).default(20),
      refresh: z.boolean().default(false).describe("회사 목록을 지금 새로 받기 (기본은 1주 캐시)"),
    },
    annotations: ro,
  },
  async ({ query, listed_only, limit, refresh }) => {
    try {
      let rows = searchCorps(await loadCorps(refresh), query);
      if (listed_only) rows = rows.filter(c => c.stock);
      if (!rows.length) return text(`'${query}' 와 일치하는 회사가 없습니다. 이름을 줄여서(예: '교촌에프앤비' → '교촌') 다시 찾아보세요.`);
      const lines = [
        `## '${query}' 검색 결과 — ${rows.length.toLocaleString()}건${rows.length > limit ? ` 중 ${limit}건` : ""}`,
        "",
        "| 회사명 | 고유번호 | 종목코드 | 최종변경 |",
        "|---|---|---|---|",
        ...rows.slice(0, limit).map(c => `| ${c.name} | ${c.code} | ${c.stock || "비상장"} | ${c.modified} |`),
        "",
        `> 회사 목록 기준일: ${new Date(corpLoadedAt).toLocaleDateString("ko-KR")} (전체 ${corpList!.length.toLocaleString()}개사)`,
      ];
      return text(lines.join("\n"));
    } catch (e) {
      return handleError(e);
    }
  }
);

// ── 도구 2: 기업개황 ─────────────────────────────────────────────────────────
  srv.registerTool(
  "dart_get_company",
  {
    title: "기업개황",
    description: "회사의 정식 명칭·대표자·법인구분·사업자번호·주소·홈페이지·업종·설립일·결산월을 조회합니다.",
    inputSchema: { company: companySchema, response_format: fmtSchema },
    annotations: ro,
  },
  async ({ company, response_format }) => {
    try {
      const c = await resolveCorp(company);
      const d = await dartJson("company", { corp_code: c.code });
      if (response_format === "json") return text(JSON.stringify(d, null, 2));
      const cls: Record<string, string> = { Y: "유가증권", K: "코스닥", N: "코넥스", E: "기타(비상장)" };
      return text([
        `## ${d.corp_name} 기업개황`,
        "",
        `- **영문명**: ${d.corp_name_eng || "-"}`,
        `- **고유번호 / 종목코드**: ${d.corp_code} / ${d.stock_code?.trim() || "비상장"} (${cls[d.corp_cls] ?? d.corp_cls})`,
        `- **대표자**: ${d.ceo_nm}`,
        `- **법인등록번호 / 사업자등록번호**: ${d.jurir_no} / ${d.bizr_no}`,
        `- **주소**: ${d.adres}`,
        `- **홈페이지**: ${d.hm_url || "-"} | **전화**: ${d.phn_no || "-"}`,
        `- **업종코드**: ${d.induty_code} | **설립일**: ${d.est_dt} | **결산월**: ${d.acc_mt}월`,
      ].join("\n"));
    } catch (e) {
      return handleError(e);
    }
  }
);

// ── 도구 3: 공시 검색 ─────────────────────────────────────────────────────────
  srv.registerTool(
  "dart_search_disclosures",
  {
    title: "공시 검색",
    description:
      "회사·기간·공시유형으로 공시 목록을 찾습니다. 결과의 접수번호(rcept_no)를 dart_read_document 에 넣으면 원문을 읽을 수 있습니다. " +
      "감사보고서는 pblntf_ty='F', 사업·분기보고서는 'A', 공정위 공시(대규모기업집단)는 'J'. " +
      "회사를 안 정하면 기간이 최대 3개월로 제한됩니다.",
    inputSchema: {
      company: companySchema.optional(),
      bgn_de: z.string().regex(/^\d{8}$/).optional().describe("시작일 YYYYMMDD (기본: 회사 지정 시 3년 전, 아니면 7일 전)"),
      end_de: z.string().regex(/^\d{8}$/).optional().describe("종료일 YYYYMMDD (기본: 오늘)"),
      pblntf_ty: z.enum(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]).optional()
        .describe("A 정기공시 · B 주요사항 · C 발행 · D 지분 · E 기타 · F 외부감사관련(감사보고서) · G 펀드 · H 자산유동화 · I 거래소 · J 공정위"),
      pblntf_detail_ty: z.string().max(4).optional().describe("공시상세유형 (예: A001 사업보고서, F001 감사보고서)"),
      report_nm: z.string().max(50).optional().describe("보고서명에 이 글자가 들어간 것만 (받은 쪽 안에서 거름)"),
      last_reprt_at: z.boolean().default(true).describe("정정 전 원본은 빼고 최종본만"),
      page_no: z.number().int().min(1).default(1),
      page_count: z.number().int().min(1).max(100).default(30),
      response_format: fmtSchema,
    },
    annotations: ro,
  },
  async ({ company, bgn_de, end_de, pblntf_ty, pblntf_detail_ty, report_nm, last_reprt_at, page_no, page_count, response_format }) => {
    try {
      const c = company ? await resolveCorp(company) : null;
      const now = new Date();
      const from = new Date(now);
      if (c) from.setFullYear(now.getFullYear() - 3); else from.setDate(now.getDate() - 7);
      const params: Record<string, string> = {
        bgn_de: bgn_de ?? ymd(from),
        end_de: end_de ?? ymd(now),
        last_reprt_at: last_reprt_at ? "Y" : "N",
        page_no: String(page_no),
        page_count: String(page_count),
      };
      if (c) params.corp_code = c.code;
      if (pblntf_ty) params.pblntf_ty = pblntf_ty;
      if (pblntf_detail_ty) params.pblntf_detail_ty = pblntf_detail_ty;
      const d = await dartJson("list", params);
      let rows: any[] = d.list ?? [];
      if (report_nm) rows = rows.filter(r => String(r.report_nm).includes(report_nm));
      if (response_format === "json") return text(JSON.stringify({ ...d, list: rows }, null, 2));

      const title = `## 공시 검색 — ${c ? corpLine(c) : "전체 회사"} · ${params.bgn_de}~${params.end_de}${pblntf_ty ? ` · ${PBLNTF_TY[pblntf_ty]}` : ""}`;
      if (!rows.length) {
        return text(`${title}\n\n조회된 공시가 없습니다.${pblntf_ty === "F" ? "" : "\n\n> 비상장사의 감사보고서를 찾는다면 `pblntf_ty=\"F\"` 로, 기간을 넓혀(`bgn_de`) 다시 찾아보세요."}`);
      }
      const total = Number(d.total_count ?? rows.length);
      const lines = [
        title,
        "",
        `전체 ${total.toLocaleString()}건 중 ${page_no}쪽${report_nm ? ` ('${report_nm}' 포함 ${rows.length}건)` : ""}${Number(d.total_page) > page_no ? ` — 다음 쪽: \`page_no=${page_no + 1}\`` : ""}`,
        "",
        "| 접수일 | 회사 | 보고서명 | 제출인 | 접수번호 |",
        "|---|---|---|---|---|",
        ...rows.map(r => `| ${r.rcept_dt} | ${r.corp_name} | [${String(r.report_nm).trim()}](https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${r.rcept_no}) | ${r.flr_nm} | ${r.rcept_no} |`),
      ];
      return text(lines.join("\n"));
    } catch (e) {
      return handleError(e);
    }
  }
);

// ── 도구 4: 재무제표 ─────────────────────────────────────────────────────────
  srv.registerTool(
  "dart_get_financials",
  {
    title: "재무제표 조회",
    description:
      "사업보고서(또는 반기·분기보고서)의 재무제표를 당기·전기·전전기로 나란히 보여줍니다. 금액은 원 단위(표는 억원으로 줄임). " +
      "scope='main' 은 매출·영업이익·순이익·자산·부채·자본 등 주요 계정(연결·별도 둘 다), 'full' 은 전체 계정. " +
      "⚠️ 사업보고서를 내는 회사(상장사·일부 큰 비상장사)의 2015년 이후 자료만 있습니다. " +
      "감사보고서만 내는 비상장사는 dart_search_disclosures(pblntf_ty='F') → dart_read_document 로 원문을 읽으세요.",
    inputSchema: {
      company: companySchema,
      bsns_year: z.string().regex(/^\d{4}$/).describe("사업연도 (예: '2025')"),
      reprt_code: reprtSchema,
      scope: z.enum(["main", "full"]).default("main"),
      fs_div: z.enum(["CFS", "OFS"]).default("CFS").describe("full 일 때: CFS 연결(기본) · OFS 별도(개별). 연결이 없는 회사는 OFS"),
      sj_div: z.enum(["BS", "IS", "CIS", "CF", "SCE"]).optional()
        .describe("full 일 때 표 하나만: BS 재무상태표 · IS 손익계산서 · CIS 포괄손익 · CF 현금흐름 · SCE 자본변동"),
      response_format: fmtSchema,
    },
    annotations: ro,
  },
  async ({ company, bsns_year, reprt_code, scope, fs_div, sj_div, response_format }) => {
    try {
      const c = await resolveCorp(company);
      const ep = scope === "main" ? "fnlttSinglAcnt" : "fnlttSinglAcntAll";
      const params: Record<string, string> = { corp_code: c.code, bsns_year, reprt_code };
      if (scope === "full") params.fs_div = fs_div;
      const d = await dartJson(ep, params);
      let rows: any[] = d.list ?? [];
      if (sj_div) rows = rows.filter(r => r.sj_div === sj_div || (sj_div === "IS" && r.sj_div === "CIS" && !d.list.some((x: any) => x.sj_div === "IS")));
      if (response_format === "json") return text(JSON.stringify({ corp: c, ...d, list: rows }, null, 2));

      const head = `## ${corpLine(c)} · ${bsns_year}년 ${REPRT_NAME[reprt_code]} · ${scope === "main" ? "주요 계정" : `전체 재무제표(${fs_div === "CFS" ? "연결" : "별도"})`}`;
      if (!rows.length) {
        const otherFs = scope === "full" && fs_div === "CFS" ? "\n\n> 연결재무제표가 없는 회사일 수 있습니다. `fs_div=\"OFS\"`(별도)로 다시 해보세요." : "";
        return text(`${head}\n\n조회된 재무 자료가 없습니다.${otherFs}\n${NO_FIN_HINT}`);
      }
      const r0 = rows[0];
      const lines = [head, "", `> 금액 단위: 원 → 표에는 억원으로 줄여 표시. 통화 ${r0.currency ?? "KRW"}. 원값은 \`response_format="json"\`.`, ""];
      const groups = new Map<string, any[]>();
      for (const r of rows) {
        const key = scope === "main" ? `${r.fs_nm} — ${r.sj_nm}` : r.sj_nm;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(r);
      }
      // "제 27 기" 만으로는 몇 년인지 모른다. 기간(…dt)의 마지막 날짜에서 연월을 붙인다.
      const col = (nm: unknown, dt: unknown, dflt: string) => {
        const ym = [...String(dt ?? "").matchAll(/(\d{4})\.(\d{2})/g)].pop();
        return `${nm ?? dflt}${ym ? ` (${ym[1]}.${ym[2]})` : ""}`;
      };
      for (const [g, rs] of groups) {
        const h = rs[0];
        lines.push(`### ${g}`, "", `| 계정 | ${col(h.thstrm_nm, h.thstrm_dt, "당기")} | ${col(h.frmtrm_nm, h.frmtrm_dt, "전기")} | ${col(h.bfefrmtrm_nm, h.bfefrmtrm_dt, "전전기")} |`, "|---|---:|---:|---:|");
        // 주요계정 API 는 당기순이익을 같은 값으로 두 번 내려준다 (교촌 2025 ord 29·61). 같은 계정·같은 값은 한 번만.
        const seen = new Set<string>();
        for (const r of rs) {
          const key = `${r.account_nm}|${r.thstrm_amount}|${r.frmtrm_amount}`;
          if (seen.has(key)) continue;
          seen.add(key);
          lines.push(`| ${r.account_nm} | ${fmtWon(r.thstrm_amount)} | ${fmtWon(r.frmtrm_amount)} | ${fmtWon(r.bfefrmtrm_amount)} |`);
        }
        lines.push("");
      }
      lines.push(`출처: [${r0.rcept_no}](https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${r0.rcept_no})`);
      return text(lines.join("\n"));
    } catch (e) {
      return handleError(e);
    }
  }
);

// ── 도구 5: 공시 원문 읽기 ───────────────────────────────────────────────────
  srv.registerTool(
  "dart_read_document",
  {
    title: "공시 원문 읽기",
    description:
      "접수번호(14자리)로 공시 원문을 받아 글자로 풀어 보여줍니다. 표는 칸을 ' | ' 로 나눕니다. " +
      "한 공시에 본문·첨부(감사보고서 등)가 여러 파일로 들어 있으면 file_index 로 고릅니다. " +
      "문서가 길면 offset 으로 넘겨 읽거나 find 로 원하는 곳(예: '재무상태표', '가맹', '최대주주')부터 읽습니다.",
    inputSchema: {
      rcept_no: z.string().regex(/^\d{14}$/).describe("접수번호 14자리 (dart_search_disclosures 결과)"),
      file_index: z.number().int().min(0).default(0).describe("몇 번째 파일 (0 = 본문)"),
      find: z.string().max(50).optional().describe("이 글자가 처음 나오는 곳부터 읽기"),
      offset: z.number().int().min(0).default(0).describe("읽기 시작 위치(글자 수)"),
      max_chars: z.number().int().min(1000).max(40000).default(15000),
    },
    annotations: ro,
  },
  async ({ rcept_no, file_index, find, offset, max_chars }) => {
    try {
      const files = await loadDocument(rcept_no);
      if (file_index >= files.length) return { ...text(`⚠️ 이 공시에는 파일이 ${files.length}개뿐입니다 (file_index 0~${files.length - 1}).`), isError: true };
      const f = files[file_index];
      let start = offset;
      if (find) {
        const at = findHeading(f.text, find, offset);
        if (at < 0) {
          const elsewhere = files.map((x, i) => (i !== file_index && findHeading(x.text, find, 0) >= 0 ? i : -1)).filter(i => i >= 0);
          return text(`'${find}' 가 ${file_index}번 파일${offset ? `의 ${offset}자 이후` : ""}에 없습니다.${elsewhere.length ? ` ${elsewhere.join(", ")}번 파일에는 있습니다.` : ""}`);
        }
        start = Math.max(0, at - 40);
      }
      const body = f.text.slice(start, start + max_chars);
      const end = start + body.length;
      const lines = [
        `## 공시 원문 ${rcept_no} — ${file_index}번 파일 (${f.text.length.toLocaleString()}자 중 ${start.toLocaleString()}~${end.toLocaleString()})`,
        "",
        files.length > 1 ? `파일 목록: ${files.map((x, i) => `[${i}] ${x.name} (${x.text.length.toLocaleString()}자)`).join(" · ")}` : "",
        `원문 보기: https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rcept_no}`,
        "",
        "```",
        body,
        "```",
        end < f.text.length ? `\n이어서 읽기: \`offset=${end}\`` : "\n(파일 끝)",
      ];
      return text(lines.filter((l, i) => l || i !== 2).join("\n"));
    } catch (e) {
      return handleError(e);
    }
  }
);

// ── 도구 6: API 목록 ─────────────────────────────────────────────────────────
  srv.registerTool(
  "dart_list_apis",
  {
    title: "OpenDART API 목록",
    description:
      "dart_call_api 로 부를 수 있는 OpenDART API 80개(최대주주·임원·직원·배당·자기주식·감사의견·증자·합병·전환사채 등)를 보여줍니다. " +
      "전용 도구가 없는 항목은 여기서 엔드포인트를 찾아 dart_call_api 로 부르세요.",
    inputSchema: {
      group: z.enum(["공시정보", "정기보고서 주요정보", "재무정보", "지분공시", "주요사항보고서", "증권신고서"]).optional(),
      keyword: z.string().max(30).optional().describe("이름에 이 글자가 들어간 것만 (예: '주주', '임원', '사채')"),
    },
    annotations: ro,
  },
  async ({ group, keyword }) => {
    let rows = DART_APIS;
    if (group) rows = rows.filter(a => a.group === group);
    if (keyword) rows = rows.filter(a => a.title.includes(keyword) || a.ep.toLowerCase().includes(keyword.toLowerCase()));
    if (!rows.length) return { ...text("해당하는 API 가 없습니다. group·keyword 없이 전체 목록을 보세요."), isError: true };
    const lines = [`## OpenDART API ${rows.length}개`];
    let cur = "";
    for (const a of rows) {
      if (a.group !== cur) { cur = a.group; lines.push("", `### ${cur}`, "", "| 이름 | endpoint | 필수 값 |", "|---|---|---|"); }
      lines.push(`| ${a.title} | \`${a.ep}\` | ${a.required.join(", ") || "-"} |`);
    }
    lines.push(
      "",
      "> 값 안내: `reprt_code` 11011 사업보고서 · 11012 반기 · 11013 1분기 · 11014 3분기 / `bsns_year` 2015 이후 /",
      "> `bgn_de`·`end_de` YYYYMMDD / `fs_div` CFS 연결 · OFS 별도 / `idx_cl_code` M210000 수익성 · M220000 안정성 · M230000 성장성 · M240000 활동성 /",
      "> 다중회사 API(fnlttMultiAcnt·fnlttCmpnyIndx)는 `params.corp_code` 에 고유번호를 쉼표로 이어 넣습니다(최대 100개).",
    );
    return text(lines.join("\n"));
  }
);

// ── 도구 7: 범용 호출 ────────────────────────────────────────────────────────
  srv.registerTool(
  "dart_call_api",
  {
    title: "OpenDART API 직접 호출",
    description:
      "dart_list_apis 에 있는 OpenDART API 를 이름(endpoint)으로 직접 부릅니다. company 를 주면 고유번호로 바꿔 corp_code 에 넣습니다. " +
      "응답은 OpenDART JSON 그대로입니다 (금액은 원 단위 문자열). 예: endpoint='hyslrSttus'(최대주주), params={bsns_year:'2025', reprt_code:'11011'}.",
    inputSchema: {
      endpoint: z.string().min(1).max(60).describe("dart_list_apis 의 endpoint (예: 'hyslrSttus', 'exctvSttus', 'alotMatter')"),
      company: companySchema.optional(),
      params: z.record(z.string(), z.string()).default({}).describe("나머지 요청 값 (예: {bsns_year:'2025', reprt_code:'11011'})"),
    },
    annotations: ro,
  },
  async ({ endpoint, company, params }) => {
    try {
      const api = DART_APIS.find(a => a.ep === endpoint);
      if (!api) return { ...text(`⚠️ '${endpoint}' 는 목록에 없는 endpoint 입니다. dart_list_apis 로 확인하세요.`), isError: true };
      const p: Record<string, string> = { ...params };
      let c: Corp | null = null;
      if (company) { c = await resolveCorp(company); p.corp_code = c.code; }
      // 정기보고서 API 는 거의 늘 연간 사업보고서를 보므로 빠지면 11011 로 채운다
      const filled = api.required.includes("reprt_code") && !p.reprt_code;
      if (filled) p.reprt_code = "11011";
      const missing = api.required.filter(k => !p[k]);
      if (missing.length) return { ...text(`⚠️ ${api.title}(${endpoint}) 에 필요한 값이 빠졌습니다: ${missing.join(", ")}`), isError: true };
      const d = await dartJson(endpoint, p);
      const head = `## ${api.title} (${endpoint})${c ? ` — ${corpLine(c)}` : ""}${filled ? " · reprt_code 를 안 줘서 사업보고서(11011)로 조회" : ""}`;
      if (d.empty) return text(`${head}\n\n조회된 데이터가 없습니다 (status 013). 연도·보고서 종류를 바꿔 보세요.${api.group === "재무정보" ? `\n${NO_FIN_HINT}` : ""}`);
      let body = JSON.stringify(d, null, 2);
      const LIMIT = 60_000;
      if (body.length > LIMIT) body = body.slice(0, LIMIT) + `\n… (응답이 길어 ${LIMIT.toLocaleString()}자에서 잘랐습니다. 조건을 좁히세요)`;
      return text(`${head}\n\n\`\`\`json\n${body}\n\`\`\``);
    } catch (e) {
      return handleError(e);
    }
  }
);

// ── 도구 8: 연결 점검 ────────────────────────────────────────────────────────
  srv.registerTool(
  "dart_check_api_access",
  {
    title: "OpenDART 연결 점검",
    description: "인증키가 설정됐는지, OpenDART 가 받아주는지, 회사 목록 캐시가 언제 것인지 확인합니다. 무언가 이상하면 먼저 호출하세요.",
    inputSchema: {},
    annotations: ro,
  },
  async () => {
    const lines = [`## OpenDART MCP 상태`, "", `- 서버 버전: **Ver ${VERSION}**`];
    let keyOk = false;
    try {
      const k = apiKey();
      lines.push(`- 인증키: 설정됨 (${k.length}자${k.length === 40 ? "" : " ⚠️ OpenDART 키는 40자"})`);
      keyOk = true;
    } catch (e) {
      lines.push(`- 인증키: **미설정** — ${(e as Error).message}`);
    }
    if (keyOk) {
      try {
        const d = await dartJson("company", { corp_code: "00126380" });
        lines.push(`- 시험 조회: ✅ 정상 (${d.corp_name})`);
      } catch (e) {
        lines.push(`- 시험 조회: ❌ ${(e as Error).message}`);
      }
    }
    if (existsSync(CORP_CACHE)) {
      const st = statSync(CORP_CACHE);
      lines.push(`- 회사 목록 캐시: ${new Date(st.mtimeMs).toLocaleString("ko-KR")} 받음 (${(st.size / 1e6).toFixed(1)}MB, 1주마다 갱신) — ${CORP_CACHE}`);
    } else {
      lines.push(`- 회사 목록 캐시: 아직 없음 (첫 회사 검색 때 받음, 수 초 걸림)`);
    }
    lines.push(`- 하루 호출 한도: 20,000건 (OpenDART 정책)`);
    return text(lines.join("\n"));
  }
);

  return srv;
}

// ── 서버 실행 ──────────────────────────────────────────────────────────────────
// 인자 없음 = 로컬 stdio (Claude Code .mcp.json), "http" = 원격 (Render — claude.ai 웹·채팅·코워크 커넥터)
if (process.argv[2] === "http") {
  const port = parseInt(process.env.PORT ?? "8765", 10);

  // claude.ai 커스텀 커넥터는 고정 헤더를 못 보낸다. 그래서 주소 자체를 비밀번호로 쓴다: /mcp/<토큰>.
  // 토큰은 MCP_AUTH_TOKEN 이 있으면 그것, 없으면 DART 키에서 만든다 — Render 에는 DART 키 하나만 넣으면 되고,
  // 키를 가진 쪽(이 PC)에서도 같은 주소를 계산할 수 있다. 토큰이 없으면 아예 뜨지 않는다(무인증 공개 금지).
  const token = process.env.MCP_AUTH_TOKEN
    || createHash("sha256").update(`opendart-mcp:${apiKey()}`).digest("hex").slice(0, 32);

  const httpServer = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0].replace(/\/+$/, "");

    // 헬스체크는 인증 없이 — Render 가 찔러본다. 키·토큰 값은 절대 내보내지 않는다.
    if (req.method === "GET" && path === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: VERSION, keySet: (() => { try { return Boolean(apiKey()); } catch { return false; } })() }));
      return;
    }

    const authed = path === `/mcp/${token}` || (path === "/mcp" && req.headers["authorization"] === `Bearer ${token}`);
    if (!authed) {
      // 주소가 틀렸는지 토큰이 틀렸는지 구분해 주지 않는다
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (req.method !== "POST") {
      // 상태 없는(stateless) 모드라 GET 스트림·DELETE 세션은 쓰지 않는다
      res.writeHead(405, { "content-type": "application/json", allow: "POST" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));
      return;
    }

    let body = "";
    req.on("data", chunk => (body += chunk));
    await new Promise(resolve => req.on("end", resolve));
    let parsed: unknown;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
      return;
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const srv = createMcpServer(); // 요청마다 새 인스턴스 — 회사 목록 캐시는 모듈 변수라 공유된다
    res.on("close", () => { transport.close(); srv.close(); });
    await srv.connect(transport);
    await transport.handleRequest(req, res, parsed);
  });
  httpServer.listen(port, "0.0.0.0", () => {
    process.stderr.write(`OpenDART MCP server Ver ${VERSION} (http) on port ${port}\n`);
  });
} else {
  const transport = new StdioServerTransport();
  await createMcpServer().connect(transport);
}
