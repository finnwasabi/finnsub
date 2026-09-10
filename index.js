const {
  addonBuilder,
  publishToCentral,
} = require("stremio-addon-sdk");
const opensubtitles = require("./opensubtitles");
const connection = require("./connection");
const languages = require("./languages");
const { createOrUpdateMessageSub } = require("./subtitles");
const translationQueue = require("./queues/translationQueue");
const baseLanguages = require("./langs/base.lang.json");
const isoCodeMapping = require("./langs/iso_code_mapping.json");
require("dotenv").config();
const fsp = require("fs").promises;

function generateSubtitleUrl(
  targetLanguage,
  imdbid,
  season,
  episode,
  provider,
  baseUrl = process.env.BASE_URL
) {
  return `${baseUrl}/subtitles/${provider}/${targetLanguage}/${imdbid}/season${season}/${imdbid}-translated-${episode}-1.srt`;
}

// Nuvio va Stremio doc ma ngon ngu theo ISO 639-2 (ba chu). Ban goc tra ve
// "vi-translated", khong khop bang ma nao nen may phat hien "Khong xac dinh".
// Bang langs/iso_code_mapping.json cua chinh addon anh xa ba chu sang hai chu,
// nen tra nguoc lai la ra ma dung cho moi ngon ngu chu khong rieng tieng Viet.
const isoCodeMap = require("./langs/iso_code_mapping.json");
function toIso639_2(twoLetter) {
  return (
    Object.keys(isoCodeMap).find((k) => isoCodeMap[k] === twoLetter) || twoLetter
  );
}


// Ban ghi trong co so du lieu chi dang tin khi file that su nam tren dia va khong phai
// ban giu cho. Truoc day addon ghi ban ghi ngay luc xep hang dich, nen mot luot dich
// hong la de lai ban ghi vinh vien: lan sau no thay "da co" roi tra thang file giu cho
// 91 byte ra ma khong goi API lan nao.
const PLACEHOLDER_MARKS = [
  "Translating subtitles",
  "No subtitles found on OpenSubtitles",
];

async function isUsableSubtitle(relativePath) {
  if (!relativePath) return false;
  if (relativePath.startsWith("http")) return true; // ban nguoi dich san tren OpenSubtitles
  try {
    const content = await fsp.readFile(relativePath, "utf-8");
    if (!content.trim()) return false;
    return !PLACEHOLDER_MARKS.some((mark) => content.includes(mark));
  } catch (err) {
    return false; // ban ghi con nhung file da bi xoa
  }
}

const builder = new addonBuilder({
  id: "com.finnwasabi.subtitletranslate",
  version: "1.0.2",
  name: "Subtitle Translate",
  logo: `${process.env.BASE_URL || ""}/assets/logo.png`,
  behaviorHints: {
    configurable: true,
    configurationRequired: true,
  },
  config: [
    {
      key: "provider",
      type: "select",
      options: ["Google Translate", "OpenAI", "Google Gemini", "OpenRouter", "Groq", "Cerebras", "Together AI", "Custom"],
    },
    {
      key: "translateto",
      type: "select",
      options: baseLanguages,
    },
    {
      key: "apikey",
      type: "text",
    },
    {
      key: "base_url",
      type: "text",
    },
    {
      key: "model_name",
      type: "text",
    },
  ],
  description:
    "Takes subtitles from OpenSubtitles and translates them into the language you pick, using Google Translate or any OpenAI compatible model. Timing and formatting are preserved, and every translation is cached so the next play is instant.",
  types: ["series", "movie"],
  catalogs: [],
  resources: ["subtitles"],
});


// Cau hinh cua Stremio di trong chinh duong dan URL, nen no chua ca khoa API. In tho
// ra log la khoa nam trong log container, journald va log truy cap cua reverse proxy.
function safeConfig(config = {}) {
  const masked = { ...config };
  if (masked.apikey) {
    masked.apikey = `***${String(masked.apikey).slice(-4)}`;
  }
  return masked;
}

builder.defineSubtitlesHandler(async function (args) {
  console.log("Subtitle request received:", {
    id: args.id,
    config: safeConfig(args.config),
  });
  const { id, config, stream } = args;

  const targetLanguage = languages.getKeyFromValue(
    config.translateto,
    config.provider
  );

  if (!targetLanguage) {
    console.log("Unsupported language:", config.translateto);
    return Promise.resolve({ subtitles: [] });
  }

  // Extract imdbid from id
  let imdbid = null;
  if (id !== null && id.startsWith("tt")) {
    const parts = id.split(":");
    if (parts.length >= 1) {
      imdbid = parts[0];
    } else {
      console.log("Invalid ID format.");
    }
  }

  if (imdbid === null) {
    console.log("Invalid ID format.");
    return Promise.resolve({ subtitles: [] });
  }

  const { type, season = null, episode = null } = parseId(id);

  try {
    // 1. Check if already exists in database
    const existingSubtitle = await connection.getsubtitles(
      imdbid,
      season,
      episode,
      targetLanguage
    );

    if (
      existingSubtitle.length > 0 &&
      !(await isUsableSubtitle(existingSubtitle[0]))
    ) {
      console.log(
        "Stale subtitle record, dropping it and translating again:",
        existingSubtitle[0]
      );
      await connection.deletesubtitle(imdbid, season, episode, targetLanguage);
      existingSubtitle.length = 0;
    }

    if (existingSubtitle.length > 0) {
      console.log(
        "Subtitle found in database:",
        generateSubtitleUrl(
          targetLanguage,
          imdbid,
          season,
          episode,
          config.provider
        )
      );
      return Promise.resolve({
        subtitles: [
          {
            id: `${imdbid}-subtitle`,
            url: generateSubtitleUrl(
              targetLanguage,
              imdbid,
              season,
              episode,
              config.provider
            ),
            lang: toIso639_2(targetLanguage),
          },
        ],
      });
    }

    // 2. If not found, search OpenSubtitles
    const subs = await opensubtitles.getsubtitles(
      type,
      imdbid,
      season,
      episode,
      targetLanguage
    );

    if (!subs || subs.length === 0) {
      await createOrUpdateMessageSub(
        "No subtitles found on OpenSubtitles",
        imdbid,
        season,
        episode,
        targetLanguage,
        config.provider
      );
      return Promise.resolve({
        subtitles: [
          {
            id: `${imdbid}-subtitle`,
            url: generateSubtitleUrl(
              targetLanguage,
              imdbid,
              season,
              episode,
              config.provider
            ),
            lang: toIso639_2(targetLanguage),
          },
        ],
      });
    }

    const foundSubtitle = subs[0];

    const mappedFoundSubtitleLang = isoCodeMapping[foundSubtitle.lang] || foundSubtitle.lang;

    if (mappedFoundSubtitleLang === targetLanguage) {
      console.log(
        "Desired language subtitle found on OpenSubtitles, returning it directly."
      );
      await connection.addsubtitle(
        imdbid,
        type,
        season,
        episode,
        foundSubtitle.url.replace(`${process.env.BASE_URL}/`, ""),
        targetLanguage
      );
      return Promise.resolve({
        subtitles: [
          {
            id: `${imdbid}-subtitle`,
            url: foundSubtitle.url,
            lang: foundSubtitle.lang,
          },
        ],
      });
    }

    console.log(
      "Subtitles found on OpenSubtitles, but not in target language. Translating..."
    );

    await createOrUpdateMessageSub(
      "Translating subtitles. Please wait 1 minute and try again.",
      imdbid,
      season,
      episode,
      targetLanguage,
      config.provider
    );

    // 3. Process and translate subtitles
    translationQueue.push({
      // Dua ca danh sach du phong chu khong chi ban dau. Nha cung cap co the liet ke
      // mot ban roi tra ve kho nen rong luc tai that, luc do ben tai se chuyen sang ban
      // ke tiep thay vi bo cuoc. Da gap that voi SubDL ngay 10/09/2026.
      subs: subs,
      imdbid: imdbid,
      season: season,
      episode: episode,
      oldisocode: targetLanguage,
      provider: config.provider,
      apikey: config.apikey ?? null,
      base_url: config.base_url ?? "https://api.openai.com/v1/responses",
      model_name: config.model_name ?? "gpt-4o-mini",
    });

    console.log(
      "Subtitles processed",
      generateSubtitleUrl(
        targetLanguage,
        imdbid,
        season,
        episode,
        config.provider
      )
    );

    return Promise.resolve({
      subtitles: [
        {
          id: `${imdbid}-subtitle`,
          url: generateSubtitleUrl(
            targetLanguage,
            imdbid,
            season,
            episode,
            config.provider
          ),
          lang: toIso639_2(targetLanguage),
        },
      ],
    });
  } catch (error) {
    console.error("Error processing subtitles:", error);
    return Promise.resolve({ subtitles: [] });
  }
});

function parseId(id) {
  if (id.startsWith("tt")) {
    const match = id.match(/tt(\d+):(\d+):(\d+)/);
    if (match) {
      const [, , season, episode] = match;
      return {
        type: "series",
        season: Number(season),
        episode: Number(episode),
      };
    } else {
      return { type: "movie", season: 1, episode: 1 };
    }
  }
  return { type: "unknown", season: 0, episode: 0 };
}

// Comment out this line for local execution, uncomment for production deployment
// Cannot publish to central locally as there is no public IP, so it won't show up in the Stremio store

if (process.env.PUBLISH_IN_STREMIO_STORE == "TRUE") {
  publishToCentral(`http://${process.env.ADDRESS}/manifest.json`);
}

const port = process.env.PORT || 3000;
const address = process.env.ADDRESS || "0.0.0.0";
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const getRouter = require("stremio-addon-sdk/src/getRouter");

const app = express();

app.use(cors());

app.use((_, res, next) => {
  res.setHeader("Cache-Control", "max-age=10, public");
  next();
});

app.get("/", (_, res) => {
  res.redirect("/configure");
});

function sendConfigurePage(res, savedConfig) {
  fs.readFile("./configure.html", "utf8", (err, data) => {
    if (err) {
      res.status(500).send("Error loading configuration page");
      return;
    }

    const html = data
      .replace("<%= languages %>", JSON.stringify(baseLanguages))
      .replace("<%= savedConfig %>", JSON.stringify(savedConfig || null))
      .replace(
        "<%= baseUrl %>",
        process.env.BASE_URL || `http://${address}:${port}`
      );

    res.setHeader("Content-Type", "text/html");
    res.send(html);
  });
}

app.get("/configure", (_req, res) => sendConfigurePage(res, null));

// Cai nut banh rang trong Stremio va Nuvio tro toi /<cau hinh>/configure. Truoc day
// duong dan do tra ve 404 nen addon khong mo lai duoc cau hinh cu, phai go di cai lai.
// Doc luon cau hinh dang dung de dien san vao form.
app.get("/:config/configure", (req, res) => {
  let saved = null;
  try {
    saved = JSON.parse(req.params.config);
  } catch (error) {
    saved = null;
  }
  sendConfigurePage(res, saved);
});

// Ban manifest do SDK sinh ra khi da co cau hinh bi rong mat behaviorHints, nen client
// tuong addon nay khong chinh duoc va giau nut banh rang di. Tra manifest o day, truoc
// router cua SDK, va giu nguyen co configurable.
app.get(["/manifest.json", "/:config/manifest.json"], (req, res) => {
  const manifest = { ...builder.getInterface().manifest };
  manifest.configurable = true;
  manifest.behaviorHints = {
    ...(manifest.behaviorHints || {}),
    configurable: true,
    configurationRequired: !req.params.config,
  };
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(manifest));
});

// Danh sach model viet cung trong trang cau hinh luon lac hau: nha cung cap khai tu
// model cu vai thang mot lan. Endpoint nay hoi thang ho bang chinh khoa cua nguoi dung,
// nen danh sach khong bao gio cu. Khoa di trong than yeu cau chu khong trong duong dan,
// de no khong roi vao log truy cap.
app.post("/api/models", express.json(), async (req, res) => {
  const { base_url, apikey } = req.body || {};
  if (!base_url || !apikey) {
    return res.status(400).json({ error: "base_url and apikey are required" });
  }

  try {
    const url = `${String(base_url).replace(/\/+$/, "")}/models`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apikey}`,
        "x-goog-api-key": apikey,
      },
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      return res
        .status(response.status)
        .json({ error: `Provider answered ${response.status}` });
    }

    const payload = await response.json();
    const list = payload.data || payload.models || [];
    // Nha cung cap tra ve ca model sinh anh, doc, nhung, xep hang. Chung khong dich
    // duoc gi, de vao danh sach chi lam nguoi dung chon nham.
    const NOT_FOR_TEXT = /embed|image|audio|tts|whisper|vision|rerank|moderation|dall-e|veo|imagen|sora/i;
    const models = list
      .map((item) => String(item.id || item.name || "").replace(/^models\//, ""))
      .filter((id) => id && !NOT_FOR_TEXT.test(id))
      .sort();

    res.json({ models });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.use("/subtitles", express.static("subtitles"));
app.use("/assets", express.static("assets"));

app.use(getRouter(builder.getInterface()));

// Hang doi nam trong bo nho, nen sau khi khoi dong lai thi moi dong con sot trong bang
// translation_queue deu la rac cua luot bi giet giua chung: container dung lai giua chung
// thi khoi finally khong bao gio chay. De nguyen thi widget dem nham la "dang cho dich".
connection
  .getAdapter()
  .then((adapter) => adapter.query("DELETE FROM translation_queue"))
  .then(() => console.log("Cleared stale translation queue rows"))
  .catch((error) => console.error("Could not clear translation queue:", error.message));

const server = app.listen(port, address, () => {
  console.log(`Server started: http://${address}:${port}`);
  console.log("Manifest available:", `http://${address}:${port}/manifest.json`);
  console.log("Configuration:", `http://${address}:${port}/configure`);
});

server.on("error", (error) => {
  console.error("Server startup error:", error);
});
