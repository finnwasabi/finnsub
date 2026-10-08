const googleTranslate = require("google-translate-api-browser");
const fs = require("fs").promises;
// Ban dong bo, chi dung cho file dem han muc: doc va ghi phai lien nhau khong co await
// o giua thi so dem moi khong bi hai luot goi dam nhau.
const fsSync = require("fs");
const path = require("path");
const OpenAI = require("openai");
require("dotenv").config();

const MAX_RETRIES = Number(process.env.TRANSLATE_MAX_RETRIES || 3);
const REQUEST_TIMEOUT = Number(process.env.TRANSLATE_TIMEOUT_MS || 180000);
const RETRY_BASE_MS = Number(process.env.TRANSLATE_RETRY_BASE_MS || 4000);
// 429 co the la tran moi PHUT chu khong phai het han muc NGAY, ma hai cai deu tra ve
// "429 no body" qua duong OpenAI-compatible nen khong phan biet duoc tu phan hoi. Cach
// duy nhat de biet la cho het mot phut roi thu lai dung model do: qua duoc thi la tran
// phut, van 429 thi moi la het ngay.
const RATE_LIMIT_WAIT_MS = Number(process.env.TRANSLATE_RATE_WAIT_MS || 65000);

/**
 * Het han muc thi thu lai bao nhieu lan cung vo ich, va con dot them han muc.
 * Tach rieng loai loi nay ra de ben goi biet la phai doi model chu khong phai doi them.
 */
class QuotaError extends Error {
  constructor(message, model) {
    super(message);
    this.name = "QuotaError";
    this.model = model;
  }
}

/**
 * Model nao vua bao het han muc thi ghi nho lai, de cac lo sau khoi goi vao no mot lan
 * nua roi lai an 429. Han muc ngay cua Google reset luc nua dem gio Thai Binh Duong, con
 * han muc phut thi vai chuc giay la xong, nen ghi nho mot tieng la du an toan cho ca hai.
 */
const exhaustedModels = new Map();
const EXHAUSTED_TTL = Number(process.env.QUOTA_MEMORY_MS || 3600000);

function markExhausted(model) {
  exhaustedModels.set(model, Date.now() + EXHAUSTED_TTL);
}

function isExhausted(model) {
  const until = exhaustedModels.get(model);
  if (!until) return false;
  if (Date.now() > until) {
    exhaustedModels.delete(model);
    return false;
  }
  return true;
}

/**
 * Khoa phu do phia may chu cap them, ngoai khoa nam trong cau hinh addon. Lam kieu nay
 * thi khong phai cai lai addon tren TV box, va khoa thu hai khong bao gio nam trong URL
 * nen khong lot vao log Caddy nhu khoa cu.
 */
const EXTRA_API_KEYS = String(process.env.TRANSLATE_EXTRA_API_KEYS || "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

function buildKeys(apikey) {
  const fromConfig = String(apikey || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  const all = [...fromConfig, ...EXTRA_API_KEYS];
  return all.filter((k, i) => all.indexOf(k) === i);
}

/**
 * Han muc mien phi cua Google tinh rieng cho tung cap (khoa, model), nen phai ghi nho
 * theo cap. Ghi nho theo rieng model la sai: khoa thu hai se bi coi la da can oan ngay
 * khi khoa thu nhat can, va nua so han muc bi bo phi.
 */
const slotOf = (keyIndex, model) => `${keyIndex}|${model}`;

/**
 * Dem so luot goi da tieu, de con biet hom nay con bao nhieu ma khong phai doi den luc
 * no het roi phu de ngung ra.
 *
 * Moc ngay phai theo gio Thai Binh Duong chu khong theo gio Viet Nam: han muc mien phi
 * cua Google reset luc nua dem ben do, tuc 14:00 gio Viet Nam. Dem theo ngay duong lich
 * o day se lech mot doan moi ngay va bao sai vao dung khung gio user hay xem phim.
 */
const USAGE_FILE = process.env.QUOTA_USAGE_FILE || "data/quota-usage.json";
const USAGE_KEEP_DAYS = Number(process.env.QUOTA_USAGE_KEEP_DAYS || 14);

const quotaDay = (at = new Date()) =>
  at.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

let usage = null;

function loadUsage() {
  if (usage) return usage;
  try {
    usage = JSON.parse(fsSync.readFileSync(USAGE_FILE, "utf8"));
  } catch {
    usage = {};
  }
  return usage;
}

// Ghi dong bo co chu dich: Node chay mot luong, doc va ghi lien nhau khong co await o
// giua nen khong the co hai luot goi dam nhau lam mat so dem.
function recordCall(keyIndex, model) {
  try {
    const data = loadUsage();
    const day = quotaDay();
    data[day] = data[day] || {};
    const slot = slotOf(keyIndex, model);
    data[day][slot] = (data[day][slot] || 0) + 1;

    const keep = Object.keys(data).sort().slice(-USAGE_KEEP_DAYS);
    for (const d of Object.keys(data)) if (!keep.includes(d)) delete data[d];

    fsSync.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
    fsSync.writeFileSync(USAGE_FILE, JSON.stringify(data));
  } catch (error) {
    // Dem hong thi ke, khong duoc phep lam vo mot luot dich that.
    console.warn(`[quota] khong ghi duoc so dem: ${error.message}`);
  }
}
// Chi bao so thu tu khoa ra log, tuyet doi khong bao gio bao gia tri khoa.
const keyLabel = (i) => `khoa #${i + 1}`;

/**
 * Tim cap (khoa, model) ke tiep con dung duoc. Di het moi cap roi moi chiu thua.
 *
 * Doi khoa truoc, ha model sau. Danh sach model xep theo chat luong giam dan, nen
 * vat can khoa 1 xuong toi model te nhat roi moi dung toi model tot nhat cua khoa 2
 * la tu lam ban dich xau di trong khi han muc ngon van con. Thu tu dung phai la
 * K1/3.7, K2/3.7, K1/3.6, K2/3.6, K1/3.5, K2/3.5.
 */
function nextSlot(keys, models, keyIndex, modelIndex) {
  const total = keys.length * models.length;
  let k = keyIndex;
  let m = modelIndex;
  for (let step = 0; step < total; step++) {
    k += 1;
    if (k >= keys.length) {
      k = 0;
      m = (m + 1) % models.length;
    }
    if (!isExhausted(slotOf(k, models[m]))) return { keyIndex: k, modelIndex: m };
  }
  return null;
}

function pickSlot(keys, models, keyIndex, modelIndex) {
  const safeKey = Math.min(keyIndex, Math.max(keys.length - 1, 0));
  const safeModel = Math.min(modelIndex, Math.max(models.length - 1, 0));
  if (!isExhausted(slotOf(safeKey, models[safeModel])))
    return { keyIndex: safeKey, modelIndex: safeModel };
  return (
    nextSlot(keys, models, safeKey, safeModel) || {
      keyIndex: safeKey,
      modelIndex: safeModel,
    }
  );
}

function isQuotaError(error) {
  const status = error?.status || error?.response?.status;
  if (status === 429) return true;
  const text = String(error?.message || "").toLowerCase();
  return (
    text.includes("resource_exhausted") ||
    text.includes("quota") ||
    text.includes("rate limit")
  );
}

/**
 * Sua chuoi JSON gan dung trong mot luot quet, giu nguyen phan da dung:
 * - thoat xuong dong, tab tho nam trong chuoi;
 * - thoat dau nhay kep nam GIUA cau thoai (`"He said "no""`), loi hay gap nhat voi phu de
 *   vi cau thoai rat hay co trich dan. Dau nhay chi duoc coi la dong chuoi khi sau no
 *   (bo qua khoang trang) la `:` `}` `]`, het chuoi, hoac `,` roi toi mot gia tri JSON moi.
 */
function repairJsonText(text) {
  let out = "";
  let inString = false;
  let escaping = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaping) {
      escaping = false;
      out += ch;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      out += ch;
      continue;
    }
    if (ch === "\n") {
      out += "\\n";
      continue;
    }
    if (ch === "\r") {
      out += "\\r";
      continue;
    }
    if (ch === "\t") {
      out += "\\t";
      continue;
    }
    if (ch === '"') {
      if (closesString(text, i + 1)) {
        inString = false;
        out += ch;
      } else {
        out += '\\"';
      }
      continue;
    }
    out += ch;
  }
  return out;
}

function closesString(text, from) {
  let j = from;
  while (j < text.length && /\s/.test(text[j])) j++;
  if (j >= text.length) return true;
  const next = text[j];
  if (next === ":" || next === "}" || next === "]") return true;
  if (next !== ",") return false;
  j++;
  while (j < text.length && /\s/.test(text[j])) j++;
  return j >= text.length || /["{\[\d\-tfn]/.test(text[j]);
}

/**
 * Cat ra doi tuong JSON can bang dau tien, bo qua dau ngoac nam trong chuoi.
 */
function firstBalancedJson(text) {
  const start = text.search(/[{[]/);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Model nho hay tra ve JSON gan dung: boc trong dau ``` , thua dau phay cuoi mang, chen
 * xuong dong tho hoac dau nhay kep chua thoat vao giua chuoi. JSON.parse tu choi het. Ham
 * nay don lai theo tung buoc, tu it can thiep den nhieu, va dung ngay khi phan tich duoc.
 */
function parseJsonLoose(raw) {
  const attempts = [];
  const text = String(raw || "").trim();
  attempts.push(text);

  // Code fence co the nam giua cau "Here is the JSON:" va loi chao cuoi, khong chi o dau.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const fenced = fence ? fence[1].trim() : text;
  if (fenced !== text) attempts.push(fenced);

  // "Unexpected non-whitespace character after JSON": model in xong mot doi tuong roi in
  // them chu hoac doi tuong thu hai. Cat tu { dau den } cuoi la dinh ca hai, nen thu
  // doi tuong can bang dau tien truoc.
  const balanced = firstBalancedJson(fenced);
  if (balanced && balanced !== fenced) attempts.push(balanced);

  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  const sliced = start !== -1 && end > start ? fenced.slice(start, end + 1) : fenced;
  if (sliced !== fenced) attempts.push(sliced);

  const repaired = repairJsonText(sliced);
  attempts.push(repaired);
  attempts.push(repaired.replace(/,\s*([}\]])/g, "$1")); // bo dau phay thua

  let lastError = null;
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Khi ca khoi JSON khong cuu duoc (thuong la bi cat ngang vi het token dau ra), van nhat
 * lay tung cap {index, text} con nguyen ven. Giu duoc 180/200 dong thi chi phai hoi lai
 * 20 dong, thay vi dot them mot luot goi cho ca lo.
 */
function salvageItems(raw) {
  const text = repairJsonText(String(raw || ""));
  const items = new Map();
  const duplicated = new Set();
  const str = '"((?:[^"\\\\]|\\\\.)*)"';
  const patterns = [
    new RegExp(`\\{\\s*"index"\\s*:\\s*(\\d+)\\s*,\\s*"text"\\s*:\\s*${str}\\s*\\}`, "g"),
    new RegExp(`\\{\\s*"text"\\s*:\\s*${str}\\s*,\\s*"index"\\s*:\\s*(\\d+)\\s*\\}`, "g"),
  ];
  patterns.forEach((pattern, order) => {
    for (const match of text.matchAll(pattern)) {
      const index = Number(order === 0 ? match[1] : match[2]);
      const body = order === 0 ? match[2] : match[1];
      try {
        const value = JSON.parse(`"${body}"`);
        // Trung index thi khong biet ban nao dung: bo ca hai, de hoi lai.
        if (items.has(index)) duplicated.add(index);
        else items.set(index, value);
      } catch {
        // Cap nay hong that su, bo qua de hoi lai.
      }
    }
  });
  for (const index of duplicated) items.delete(index);
  return items;
}

/**
 * Doi ket qua cua model ra mot mang dung bang so dong gui di, dong nao thieu thi de null.
 * Xep theo index chu khong theo thu tu tra ve: model bo sot mot dong thi chi dong do trong,
 * cac dong sau khong bi day lech len.
 */
function toLines(parsed, count) {
  const lines = new Array(count).fill(null);
  const list = Array.isArray(parsed) ? parsed : parsed?.texts;
  if (!Array.isArray(list)) return lines;

  // Mang chuoi tran khong co index thi khong biet cau nao cua dong nao: dem du so luong
  // van co the la gop mot cau roi tach mot cau khac. Bo ca, de hoi lai.
  const seen = new Set();
  const duplicated = new Set();
  for (const item of list) {
    const index = Number(item?.index);
    if (!Number.isInteger(index) || index < 0 || index >= count) continue;
    if (typeof item?.text !== "string") continue;
    if (seen.has(index)) duplicated.add(index);
    seen.add(index);
    lines[index] = item.text;
  }
  // Mot index xuat hien hai lan la dau hieu model da truot thu tu: khong biet ban nao
  // dung, nen bo trong de hoi lai thay vi doan.
  for (const index of duplicated) lines[index] = null;
  return lines;
}

function buildPrompt(texts, targetLanguage) {
  const jsonInput = { texts: texts.map((text, index) => ({ index, text })) };
  return `You are a professional movie subtitle translator.\nTranslate each subtitle text in the "texts" array of the following JSON object into the specified language "${targetLanguage}".\n\nThe output must be a JSON object with the same structure as the input. The "texts" array should contain the translated texts corresponding to their original indices.\n\n**Strict Requirements:**\n- Strictly preserve line breaks and original formatting for each subtitle.\n- Do not combine or split texts during translation.\n- The number of elements in the output array must exactly match the input array, and every element must keep its original "index".\n- Escape every line break inside a JSON string as \\n and every double quote inside a JSON string as \\" so the output stays valid JSON.\n- Ensure the final JSON is valid and retains the complete structure.\n\nInput:\n${JSON.stringify(
    jsonInput
  )}\n`;
}

/**
 * Ep model tra ve dung khuon bang response schema thay vi chi "json_object": voi Gemini
 * day la che do sinh co rang buoc, model khong the viet ra JSON sai cu phap nua. Mot so
 * nha cung cap OpenAI-compatible chua ho tro json_schema va tra 400, nen nho lai cap
 * (base_url, model) do va lui ve json_object.
 */
const USE_JSON_SCHEMA = process.env.TRANSLATE_JSON_SCHEMA !== "false";
const noSchemaSupport = new Set();

// Tai lieu structured output cua Gemini liet ke minItems, maxItems, minimum, maximum la
// tu khoa duoc ho tro, nen khoa luon so dong va khoang index cua tung lo.
// https://ai.google.dev/gemini-api/docs/openai#structured-output
// https://ai.google.dev/gemini-api/docs/structured-output
function translationSchema(count) {
  return {
    type: "json_schema",
    json_schema: {
      name: "subtitle_translation",
      schema: {
        type: "object",
        properties: {
          texts: {
            type: "array",
            minItems: count,
            maxItems: count,
            items: {
              type: "object",
              properties: {
                index: { type: "integer", minimum: 0, maximum: Math.max(count - 1, 0) },
                text: { type: "string" },
              },
              required: ["index", "text"],
            },
          },
        },
        required: ["texts"],
      },
    },
  };
}

// Gemini qua duong OpenAI-compatible hay tra loi khong co body ("400 status code (no
// body)"), nen khong doc duoc ly do. Luot nay da gui kem schema, 400/422 thi coi nhu
// schema bi tu choi: lui ve json_object chi ton them mot luot, con doan sai thi ca lo hong.
function isSchemaUnsupported(error) {
  const status = error?.status || error?.response?.status;
  return status === 400 || status === 422;
}

async function callOpenAiCompatible(
  texts,
  targetLanguage,
  apikey,
  base_url,
  model,
  keyIndex = 0
) {
  const openai = new OpenAI({
    apiKey: apikey,
    baseURL: base_url,
    timeout: REQUEST_TIMEOUT,
    maxRetries: 0, // thu lai o tang tren, de con phan biet loi het han muc
  });

  const request = {
    messages: [{ role: "user", content: buildPrompt(texts, targetLanguage) }],
    model,
    temperature: 0.3,
  };
  const schemaKey = `${base_url}|${model}`;
  let completion;
  if (USE_JSON_SCHEMA && !noSchemaSupport.has(schemaKey)) {
    try {
      completion = await openai.chat.completions.create({
        ...request,
        response_format: translationSchema(texts.length),
      });
    } catch (error) {
      if (!isSchemaUnsupported(error)) throw error;
      noSchemaSupport.add(schemaKey);
      console.log(`${model} rejected response schema, falling back to json_object`);
    }
  }
  if (!completion) {
    completion = await openai.chat.completions.create({
      ...request,
      response_format: { type: "json_object" },
    });
  }
  // Luot goi da tinh vao han muc ke ca khi JSON hong, nen dem truoc khi phan tich.
  recordCall(keyIndex, model);

  const choice = completion.choices[0];
  const content = choice?.message?.content;
  if (choice?.finish_reason === "length") {
    console.log(`${model} hit the output token limit on ${texts.length} lines`);
  }

  let lines;
  try {
    lines = toLines(parseJsonLoose(content), texts.length);
  } catch {
    const salvaged = salvageItems(content);
    lines = new Array(texts.length).fill(null);
    for (const [index, text] of salvaged) {
      if (index < texts.length) lines[index] = text;
    }
  }

  const kept = lines.filter((line) => line !== null).length;
  if (kept === 0) {
    throw new Error(`Malformed JSON from ${model}, no line could be recovered`);
  }
  // Mot dong cho moi luot goi thanh cong, co ten model. Dem dong nay trong log la biet
  // chinh xac han muc ngay cua tung model, thay vi phai tin vao tai lieu cua nha cung cap.
  console.log(`Translated ${kept}/${texts.length} lines with ${model}`);
  return lines;
}

/**
 * Loi da qua mot tang thu lai ben trong thi tang ngoai khong duoc thu lai lan nua: neu
 * khong mot lo hong se an MAX_RETRIES^2 luot goi thay vi MAX_RETRIES.
 */
function nested(promise) {
  return promise.catch((error) => {
    error.alreadyRetried = true;
    throw error;
  });
}

async function translateTextWithRetry(
  texts,
  targetLanguage,
  provider,
  apikey,
  base_url,
  model_name,
  attempt = 1,
  maxRetries = MAX_RETRIES,
  modelIndex = 0,
  waitedForRateLimit = false,
  keyIndex = 0
) {
  // model_name nhan mot danh sach ngan cach bang dau phay, vi du
  // "gemini-3.6-flash, gemini-3.5-flash". Han muc mien phi tinh RIENG cho tung model,
  // nen het model dau la con model sau, khong phai cho sang ngay hom sau.
  const models = String(model_name || "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const keys = buildKeys(apikey);
  // Bo qua cap (khoa, model) vua bao het han muc, tru khi moi cap deu dang bi danh dau.
  const slot = pickSlot(keys, models, keyIndex, modelIndex);
  const index = slot.modelIndex;
  const activeKeyIndex = slot.keyIndex;
  const model = models[index] || models[0] || model_name;
  const activeKey = keys[activeKeyIndex] || keys[0] || apikey;

  try {
    let result = null;
    let resultArray = [];

    switch (provider) {
      case "Google Translate": {
        const textToTranslate = texts.join(" ||| ");
        result = await googleTranslate.translate(textToTranslate, {
          to: targetLanguage,
          corsUrl: process.env.CORS_URL || "http://cors-anywhere.herokuapp.com/",
        });
        resultArray = result.text.split("|||");
        if (texts.length !== resultArray.length && resultArray.length > 0) {
          const diff = texts.length - resultArray.length;
          if (diff > 0) {
            const splitted = resultArray[0].split(" ");
            if (splitted.length === diff + 1) {
              resultArray = [...splitted, ...resultArray.slice(1)];
            }
          }
        }
        break;
      }
      case "OpenAI":
      case "Google Gemini":
      case "OpenRouter":
      case "Groq":
      case "Cerebras":
      case "Together AI":
      case "Custom":
      case "ChatGPT API": {
        resultArray = await callOpenAiCompatible(
          texts,
          targetLanguage,
          activeKey,
          base_url,
          model,
          activeKeyIndex
        );

        // Model tra ve thieu dong hoac JSON vo mot phan: chi hoi lai nhung dong con thieu.
        const missing = [];
        resultArray.forEach((line, i) => line === null && missing.push(i));
        if (missing.length > 0) {
          if (attempt >= maxRetries) {
            throw new Error(
              `Max retries (${maxRetries}) reached. ${missing.length} lines still missing.`
            );
          }
          console.log(
            `Attempt ${attempt}/${maxRetries} on ${model} kept ${
              texts.length - missing.length
            }/${texts.length} lines, asking again for the ${missing.length} missing`
          );
          const filled = await nested(
            translateTextWithRetry(
              missing.map((i) => texts[i]),
              targetLanguage,
              provider,
              apikey,
              base_url,
              model_name,
              attempt + 1,
              maxRetries,
              index,
              waitedForRateLimit,
              activeKeyIndex
            )
          );
          missing.forEach((lineIndex, j) => (resultArray[lineIndex] = filled[j]));
        }
        break;
      }
      default:
        throw new Error(`Provider not supported: ${provider}`);
    }

    if (texts.length != resultArray.length) {
      console.log(
        `Attempt ${attempt}/${maxRetries} on ${model} failed. Text count mismatch:`,
        texts.length,
        resultArray.length
      );

      if (process.env.DEBUG_TRANSLATE === "true") {
        await fs.mkdir("debug", { recursive: true });
        await fs.writeFile(
          `debug/errorTranslate-${Date.now()}-${attempt}.json`,
          JSON.stringify({ attempt, model, texts, translatedText: resultArray }, null, 2)
        );
      }

      if (attempt >= maxRetries) {
        throw new Error(
          `Max retries (${maxRetries}) reached. Text count mismatch.`
        );
      }

      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * attempt));
      return await nested(
        translateTextWithRetry(
          texts,
          targetLanguage,
          provider,
          apikey,
          base_url,
          model_name,
          attempt + 1,
          maxRetries,
          index,
          waitedForRateLimit,
          activeKeyIndex
        )
      );
    }

    return Array.isArray(texts) ? resultArray : result.text;
  } catch (error) {
    // Loi tu mot tang thu lai ben trong (ke ca QuotaError, vi no cung chua chu "quota")
    // da duoc xu ly xong roi, chi viec chuyen len.
    if (error.alreadyRetried || error instanceof QuotaError) throw error;

    if (isQuotaError(error)) {
      if (!waitedForRateLimit) {
        console.log(
          `Rate limited on ${model}, waiting ${Math.round(
            RATE_LIMIT_WAIT_MS / 1000
          )}s to tell a per minute limit from a spent daily quota`
        );
        await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_WAIT_MS));
        return translateTextWithRetry(
          texts,
          targetLanguage,
          provider,
          apikey,
          base_url,
          model_name,
          1,
          maxRetries,
          index,
          true,
          activeKeyIndex
        );
      }

      markExhausted(slotOf(activeKeyIndex, model));
      const next = nextSlot(keys, models, activeKeyIndex, index);
      if (next) {
        console.log(
          `Quota reached on ${model} (${keyLabel(activeKeyIndex)}), switching to ${
            models[next.modelIndex]
          } (${keyLabel(next.keyIndex)})`
        );
        return translateTextWithRetry(
          texts,
          targetLanguage,
          provider,
          apikey,
          base_url,
          model_name,
          1,
          maxRetries,
          next.modelIndex,
          false,
          next.keyIndex
        );
      }
      // Het sach model: bao dung loai loi de ben goi khoi cat nho lo ra thu lai,
      // vi cat nho chi lam ton them luot goi ma van bi tu choi.
      throw new QuotaError(
        `Quota exhausted on every key and model (${keys.length} khoa x ` +
          `${models.length} model: ${models.join(", ")})`,
        model
      );
    }

    if (attempt >= maxRetries) {
      throw error;
    }

    console.error(
      `Attempt ${attempt}/${maxRetries} on ${model} (${keyLabel(activeKeyIndex)}) failed with error:`,
      error.message
    );
    await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * attempt));
    return translateTextWithRetry(
      texts,
      targetLanguage,
      provider,
      apikey,
      base_url,
      model_name,
      attempt + 1,
      maxRetries,
      index,
      waitedForRateLimit,
      activeKeyIndex
    );
  }
}

async function translateText(
  texts,
  targetLanguage,
  provider,
  apikey,
  base_url,
  model_name
) {
  return translateTextWithRetry(
    texts,
    targetLanguage,
    provider,
    apikey,
    base_url,
    model_name
  );
}

module.exports = {
  translateText,
  QuotaError,
  parseJsonLoose,
  repairJsonText,
  salvageItems,
  toLines,
  translationSchema,
  nextSlot,
  pickSlot,
  markExhausted,
  slotOf,
};
