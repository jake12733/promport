// supabase/functions/generate/index.ts
// PromptStudio 기본 AI 프록시
//  - 사이트는 프롬프트(또는 대화)와 모델 이름만 보냄
//  - 이 함수가 서버 비밀값 GEMINI_API_KEY로 Gemini를 호출하고 결과(스트리밍 포함)를 돌려줌
//  - 로그인 + 회원가입 완료(profiles.registered=true) 사용자만 호출 가능
//  - 사용자당 하루 DAILY_LIMIT회(기본 30회, 한국 시간 기준) 제한
//
// 배포: supabase functions deploy generate --no-verify-jwt   (JWT는 함수 안에서 직접 검증)
// 비밀값: supabase secrets set GEMINI_API_KEY=새키   (선택: DAILY_LIMIT=30, ALLOWED_ORIGINS=https://a.com,https://b.com)

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const DAILY_LIMIT = Number(Deno.env.get("DAILY_LIMIT") ?? "30");

// 공개 키(사용자 토큰 확인용)와 서버 키(사용량 기록용). 새 API 키 체계와 기존 키 모두 지원
function firstKey(jsonEnv: string, legacyEnv: string): string {
  try {
    const o = JSON.parse(Deno.env.get(jsonEnv) ?? "{}");
    const v = o.default ?? Object.values(o)[0];
    if (typeof v === "string" && v) return v;
  } catch { /* ignore */ }
  return Deno.env.get(legacyEnv) ?? "";
}
const PUBLIC_KEY = firstKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");
const SERVICE_KEY = firstKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
const svcHeaders = (): Record<string, string> => {
  const h: Record<string, string> = { apikey: SERVICE_KEY, "Content-Type": "application/json" };
  if (SERVICE_KEY.startsWith("eyJ")) h.Authorization = `Bearer ${SERVICE_KEY}`;
  return h;
};

const ALLOWED_MODELS = ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.5-flash-lite", "gemini-2.5-flash"];
const FALLBACK = ["gemini-flash-lite-latest", "gemini-flash-latest"];
const MAX_CHARS = 30000;
const MAX_MESSAGES = 40;

const ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "https://jake12733.github.io")
  .split(",").map((s) => s.trim()).filter(Boolean);
function cors(req: Request): Record<string, string> {
  const o = req.headers.get("origin") ?? "";
  const ok = ORIGINS.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  return {
    "Access-Control-Allow-Origin": ok ? o : ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Expose-Headers": "x-usage-remaining, x-model",
    "Vary": "Origin",
  };
}
const json = (req: Request, status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json; charset=utf-8", ...extra } });

type Msg = { role: string; text: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, 405, { error: "method_not_allowed" });
  if (!GEMINI_KEY) return json(req, 500, { error: "server_not_configured", message: "GEMINI_API_KEY 비밀값이 없습니다." });

  // 1) 로그인 확인
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json(req, 401, { error: "login_required", message: "로그인이 필요해요." });
  const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: PUBLIC_KEY, Authorization: `Bearer ${token}` } });
  if (!ur.ok) return json(req, 401, { error: "login_required", message: "로그인이 만료됐어요. 다시 로그인해 주세요." });
  const user = await ur.json();
  const uid: string = user?.id;
  if (!uid) return json(req, 401, { error: "login_required", message: "로그인이 필요해요." });

  // 2) 회원가입(약관 동의) 완료 확인
  const pr = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${uid}&select=registered`, { headers: svcHeaders() });
  const prof = pr.ok ? (await pr.json())[0] : null;
  if (!prof?.registered) return json(req, 403, { error: "signup_required", message: "회원가입을 먼저 완료해 주세요." });

  // 3) 입력 검사
  let body: { prompt?: string; system?: string; messages?: Msg[]; model?: string; stream?: boolean };
  try { body = await req.json(); } catch { return json(req, 400, { error: "bad_json" }); }
  const stream = body.stream !== false;
  const want = ALLOWED_MODELS.includes(String(body.model)) ? String(body.model) : FALLBACK[0];
  let contents: { role: string; parts: { text: string }[] }[] = [];
  if (Array.isArray(body.messages) && body.messages.length) {
    contents = body.messages.slice(-MAX_MESSAGES)
      .filter((m) => m && typeof m.text === "string" && m.text.trim())
      .map((m) => ({ role: m.role === "user" ? "user" : "model", parts: [{ text: m.text }] }));
  } else if (typeof body.prompt === "string" && body.prompt.trim()) {
    contents = [{ role: "user", parts: [{ text: body.prompt }] }];
  }
  if (!contents.length) return json(req, 400, { error: "empty", message: "보낼 내용이 없어요." });
  const system = typeof body.system === "string" ? body.system.slice(0, 8000) : "";
  const size = contents.reduce((n, c) => n + c.parts[0].text.length, 0) + system.length;
  if (size > MAX_CHARS) return json(req, 413, { error: "too_long", message: `입력이 너무 길어요(최대 ${MAX_CHARS.toLocaleString()}자).` });

  // 4) 하루 사용량 차감 (원자적)
  const br = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ai_usage_bump`, {
    method: "POST", headers: svcHeaders(), body: JSON.stringify({ p_user: uid, p_limit: DAILY_LIMIT }),
  });
  if (!br.ok) return json(req, 500, { error: "usage_error", message: "사용량 확인에 실패했어요." });
  const used = await br.json();
  if (used === null) {
    return json(req, 429, { error: "daily_limit", message: `오늘 기본 AI 사용 횟수(${DAILY_LIMIT}회)를 모두 썼어요. 내일 다시 이용하거나 ⚙️ 설정에서 내 API 키를 넣어 주세요.` }, { "x-usage-remaining": "0" });
  }
  const remaining = String(Math.max(0, DAILY_LIMIT - Number(used)));
  const refund = () => fetch(`${SUPABASE_URL}/rest/v1/rpc/ai_usage_refund`, { method: "POST", headers: svcHeaders(), body: JSON.stringify({ p_user: uid }) }).catch(() => {});

  // 5) Gemini 호출 (모델이 막히면 다음 모델로)
  const payload = JSON.stringify({ ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), contents });
  const models = [want, ...FALLBACK.filter((m) => m !== want)];
  let lastStatus = 502, lastMsg = "AI 응답을 받지 못했어요.";
  for (const m of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
    let r: Response;
    try {
      r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY }, body: payload, signal: AbortSignal.timeout(25000) });
    } catch { lastStatus = 504; lastMsg = "AI 응답 시간이 초과됐어요."; continue; }
    if (r.ok) {
      const h = { ...cors(req), "x-usage-remaining": remaining, "x-model": m };
      if (stream) return new Response(r.body, { headers: { ...h, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" } });
      const j = await r.json();
      const text = (j.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
      return json(req, 200, { text, model: m }, h);
    }
    const e = await r.json().catch(() => ({}));
    lastStatus = r.status; lastMsg = e?.error?.message ?? `Gemini 오류 ${r.status}`;
    if (![404, 429, 500, 503].includes(r.status)) break;
  }
  await refund();
  return json(req, lastStatus >= 500 || lastStatus === 429 ? 503 : 502, { error: "upstream", message: lastMsg }, { "x-usage-remaining": remaining });
});
