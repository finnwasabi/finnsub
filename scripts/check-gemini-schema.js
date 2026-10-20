#!/usr/bin/env node
/**
 * Thu that mot lo phu de qua Gemini (duong OpenAI-compatible) de biet:
 * - Gemini co nhan response_format json_schema khong, hay tra 400 va addon se lui ve json_object;
 * - ket qua co phan tich duoc bang JSON.parse thuan khong, giu duoc bao nhieu dong, index co dung khong.
 *
 * Moi model ton 1 luot goi (2 luot neu schema bi tu choi hoac co --compare). Khong in khoa ra man hinh.
 *
 *   GEMINI_API_KEY=... node scripts/check-gemini-schema.js
 *   GEMINI_API_KEY=... node scripts/check-gemini-schema.js --models gemini-3.6-flash,gemini-3.5-flash --lines 120 --compare
 *
 * Trong Docker tren VPS:
 *   docker compose run --rm -e GEMINI_API_KEY=... stremio-translate node scripts/check-gemini-schema.js
 */
const OpenAI = require("openai");
const {
  buildPrompt,
  translationSchema,
  parseJsonLoose,
  toLines,
} = require("../translateProvider");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

const apiKey =
  process.env.GEMINI_API_KEY ||
  String(process.env.TRANSLATE_EXTRA_API_KEYS || "").split(",")[0].trim();
const baseURL = arg(
  "base-url",
  process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai"
);
const models = String(arg("models", process.env.GEMINI_MODELS || "gemini-3.6-flash"))
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const lineCount = Number(arg("lines", 40));
const language = String(arg("lang", "Vietnamese"));
const compare = arg("compare", false) === true;

if (!apiKey) {
  console.error("Thieu khoa: dat GEMINI_API_KEY (hoac TRANSLATE_EXTRA_API_KEYS).");
  process.exit(2);
}

// Cau thoai co dau nhay kep, xuong dong va the <i>: dung nhung thu hay lam vo JSON nhat.
const SAMPLE = [
  "Where were you last night?",
  'He said "no" and walked away.',
  "<i>Previously on the show...</i>",
  "Wait.\nDon't move.",
  "I'm not going back there. Not after what happened.",
  '"Trust me," she said, "it\'s fine."',
  "- Who's there?\n- It's me!",
  "We have 10 minutes, maybe less.",
  "Get down! Get down!",
  "Thank you. For everything.",
];
const texts = Array.from({ length: lineCount }, (_, i) => SAMPLE[i % SAMPLE.length]);

function describe(content, finishReason) {
  let strict = false;
  try {
    JSON.parse(content);
    strict = true;
  } catch {}
  let lines = new Array(texts.length).fill(null);
  let loose = false;
  try {
    lines = toLines(parseJsonLoose(content), texts.length);
    loose = true;
  } catch {}
  const kept = lines.filter((l) => l !== null).length;
  const sameAsSource = lines.filter((l, i) => l === texts[i]).length;
  return { finishReason, strict, loose, kept, sameAsSource };
}

async function run(openai, model, responseFormat) {
  const started = Date.now();
  try {
    const completion = await openai.chat.completions.create({
      model,
      temperature: 0.3,
      messages: [{ role: "user", content: buildPrompt(texts, language) }],
      response_format: responseFormat,
    });
    const choice = completion.choices[0];
    return {
      ok: true,
      ms: Date.now() - started,
      ...describe(choice?.message?.content || "", choice?.finish_reason),
      sample: lines0(choice?.message?.content),
    };
  } catch (error) {
    const status = error?.status || error?.response?.status;
    return { ok: false, ms: Date.now() - started, status, message: error.message };
  }
}

function lines0(content) {
  try {
    return toLines(parseJsonLoose(content), texts.length).slice(0, 3);
  } catch {
    return String(content || "").slice(0, 200);
  }
}

function print(label, r) {
  if (!r.ok) {
    console.log(`  ${label}: LOI ${r.status ?? "?"} sau ${r.ms}ms: ${r.message}`);
    return;
  }
  console.log(
    `  ${label}: ${r.ms}ms, finish=${r.finishReason}, JSON.parse=${r.strict ? "ok" : "HONG"}, ` +
      `parse loose=${r.loose ? "ok" : "HONG"}, giu ${r.kept}/${texts.length} dong` +
      (r.sameAsSource ? `, ${r.sameAsSource} dong chua dich` : "")
  );
  console.log(`    vi du: ${JSON.stringify(r.sample)}`);
}

(async () => {
  const openai = new OpenAI({ apiKey, baseURL, timeout: 180000, maxRetries: 0 });
  console.log(`Base URL: ${baseURL}`);
  console.log(`Lo thu: ${texts.length} dong -> ${language}\n`);

  let allGood = true;
  for (const model of models) {
    console.log(`Model ${model}`);
    const schema = await run(openai, model, translationSchema(texts.length));
    print("json_schema", schema);

    let verdict;
    if (schema.ok) {
      verdict =
        schema.strict && schema.kept === texts.length
          ? "schema DUOC NHAN, JSON chuan, du dong"
          : "schema duoc nhan nhung ket qua chua tron ven";
    } else if (schema.status === 400 || schema.status === 422) {
      verdict = "schema BI TU CHOI, addon se lui ve json_object";
    } else {
      verdict = "loi khac (han muc, mang, khoa?), chua ket luan duoc ve schema";
    }

    if (!schema.ok || compare) {
      print("json_object", await run(openai, model, { type: "json_object" }));
    }
    console.log(`  => ${verdict}\n`);
    if (!(schema.ok && schema.strict && schema.kept === texts.length)) allGood = false;
  }
  process.exit(allGood ? 0 : 1);
})();
