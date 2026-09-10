const axios = require("axios");
const fs = require("fs").promises;

const isoCodeMapping = require("./langs/iso_code_mapping.json");

// Ba nguon phu de, cung mot giao thuc addon Stremio nen doc chung mot kieu.
// OpenSubtitles khong can khoa. SubDL va SubSource bat buoc co khoa, thieu khoa
// thi chung tra ve mot "phu de" gia bao loi chu khong tra ve mang rong.
const OPENSUBTITLES_URL =
  process.env.OPENSUBTITLES_URL || "https://opensubtitles-v3.strem.io";
const SUBDL_URL = process.env.SUBDL_URL || "https://subdl.strem.top";
const SUBSOURCE_URL = process.env.SUBSOURCE_URL || "https://subsource.strem.top";

const SUBDL_API_KEY = (process.env.SUBDL_API_KEY || "").trim();
const SUBSOURCE_API_KEY = (process.env.SUBSOURCE_API_KEY || "").trim();

const SOURCE_TIMEOUT_MS = Number(process.env.SUBTITLE_SOURCE_TIMEOUT_MS || 9000);
// So ban du phong se thu tai truoc khi chiu thua. Nha cung cap co the liet ke mot ban
// roi tra ve kho nen rong khi tai that, nen liet ke duoc khong co nghia la dung duoc.
const MAX_CANDIDATES = Number(process.env.SUBTITLE_MAX_CANDIDATES || 5);
// Mot phu de that luon co nhieu khoi thoi gian. File bao loi cua nha cung cap chi co
// dung mot khoi, vi du "No supported subtitle file found in the subtitle archive".
const MIN_CUES = Number(process.env.SUBTITLE_MIN_CUES || 5);

// Nhung ban ghi mang hinh dang phu de nhung thuc chat la thong bao loi cua nha cung cap.
const ERROR_MARKS =
  /invalid-addon-config|error-subtitle|error_api_key|addon-configuration/i;

const b64 = (s) => Buffer.from(s).toString("base64");

// Khoa SubDL va SubSource nam trong duong dan duoi dang base64. Axios thuong khong
// nhet URL vao thong bao loi, nhung day la thu khong duoc phep sai mot lan nao,
// nen chui sach moi doan base64 dai truoc khi ghi ra log.
const scrub = (text) =>
  String(text || "").replace(/[A-Za-z0-9+/=]{24,}/g, "<redacted>");

// Duong dan tai nguyen chung: /subtitles/<type>/<id>.json
const resourcePath = (type, imdbid, season, episode) =>
  type === "series"
    ? `subtitles/${type}/${imdbid}:${season}:${episode}.json`
    : `subtitles/${type}/${imdbid}.json`;

// Danh sach nguon se hoi, theo dung thu tu uu tien khi hoa diem.
const buildSources = (type, imdbid, season, episode, targetLanguage) => {
  const path = resourcePath(type, imdbid, season, episode);
  const langs = `${targetLanguage},en`;
  const sources = [{ name: "OpenSubtitles", url: `${OPENSUBTITLES_URL}/${path}` }];

  if (SUBDL_API_KEY) {
    const cfg = b64(`${SUBDL_API_KEY}/${langs}/false`);
    sources.push({ name: "SubDL", url: `${SUBDL_URL}/${cfg}/${path}` });
  }
  if (SUBSOURCE_API_KEY) {
    const cfg = b64(`${SUBSOURCE_API_KEY}/${langs}/false/type:${type}`);
    sources.push({ name: "SubSource", url: `${SUBSOURCE_URL}/${cfg}/${path}` });
  }
  return sources;
};

// Hoi mot nguon. Khong bao gio nem ra: mot nguon chet khong duoc keo do ca chuoi.
const fetchFromSource = async (source) => {
  try {
    const response = await axios.get(source.url, { timeout: SOURCE_TIMEOUT_MS });
    const list = response.data && response.data.subtitles;
    if (!Array.isArray(list)) return [];

    const usable = list.filter(
      (s) => s && s.url && !ERROR_MARKS.test(`${s.id || ""} ${s.url}`)
    );
    console.log(
      `[subtitles] ${source.name}: ${usable.length} ban dung duoc / ${list.length} tra ve`
    );
    return usable.map((s) => ({ url: s.url, lang: s.lang, source: source.name }));
  } catch (error) {
    console.warn(`[subtitles] ${source.name} that bai: ${scrub(error.message)}`);
    return [];
  }
};

// Kiem file vua tai co that su la phu de khong. Dem khoi thoi gian la du: dau "-->"
// la ASCII nen song qua moi bang ma, con file bao loi thi chi co mot khoi.
const looksLikeRealSubtitle = (buffer) => {
  const text = Buffer.from(buffer).toString("utf8");
  const cues = (text.match(/-->/g) || []).length;
  return cues >= MIN_CUES;
};

/**
 * Ban da co san dung ngon ngu dich duoc tra thang cho nguoi xem, khong di qua buoc tai
 * ve nen khong duoc loc boi looksLikeRealSubtitle. Ham nay bit dung cho do: hoi thu mot
 * doan dau file. Doc 8 KB la du, phu de that co hang chuc khoi trong ngan ay, con file
 * bao loi cua nha cung cap chi co dung mot khoi.
 */
const isServableSubtitle = async (url) => {
  try {
    const response = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: SOURCE_TIMEOUT_MS,
      headers: { Range: "bytes=0-8191" },
      // May chu tra 206 khi chap nhan Range, 200 khi khong. Ca hai deu dung duoc.
      validateStatus: (status) => status === 200 || status === 206,
    });
    return looksLikeRealSubtitle(response.data);
  } catch (error) {
    console.warn(`[subtitles] khong hoi duoc ban co san: ${scrub(error.message)}`);
    return false;
  }
};

const downloadSubtitles = async (
  subtitles,
  imdbid,
  season = null,
  episode = null,
  oldisocode
) => {
  let uniqueTempFolder = null;
  if (season && episode) {
    await fs.mkdir(`subtitles/${oldisocode}/${imdbid}/season${season}`, {
      recursive: true,
    });
    uniqueTempFolder = `subtitles/${oldisocode}/${imdbid}/season${season}`;
  } else {
    await fs.mkdir(`subtitles/${oldisocode}/${imdbid}`, { recursive: true });
    uniqueTempFolder = `subtitles/${oldisocode}/${imdbid}`;
  }

  // Ten file giu nguyen nhu khi chi co mot ban, de moi buoc phia sau khong doi gi.
  const filePath = episode
    ? `${uniqueTempFolder}/${imdbid}-subtitle_${episode}-1.srt`
    : `${uniqueTempFolder}/${imdbid}-subtitle-1.srt`;

  for (let i = 0; i < subtitles.length; i++) {
    const candidate = subtitles[i];
    const label = `${candidate.lang || "?"} tu ${candidate.source || "?"}`;
    try {
      const response = await axios.get(candidate.url, {
        responseType: "arraybuffer",
        timeout: SOURCE_TIMEOUT_MS,
      });

      if (!looksLikeRealSubtitle(response.data)) {
        console.warn(
          `[subtitles] bo ban ${label}: tai ve duoc nhung khong phai phu de that`
        );
        continue;
      }

      await fs.writeFile(filePath, response.data);
      console.log(`[subtitles] dung ban ${label}: ${filePath}`);
      return [filePath];
    } catch (error) {
      console.warn(`[subtitles] bo ban ${label}: ${scrub(error.message)}`);
    }
  }

  // Het ban du phong. Tra ve mang rong chu khong nem loi: ben goi da biet cach xu ly
  // truong hop khong co phu de, con nem loi thi mat luon thong bao tu te cho nguoi xem.
  console.warn(
    `[subtitles] ca ${subtitles.length} ban du phong deu hong cho ${imdbid}`
  );
  return [];
};

const getsubtitles = async (
  type,
  imdbid,
  season = null,
  episode = null,
  newisocode
) => {
  const sources = buildSources(type, imdbid, season, episode, newisocode);

  // Hoi song song. Nguon cham nhat quyet dinh tong thoi gian, khong phai tong cac nguon.
  const results = await Promise.all(sources.map(fetchFromSource));
  const subtitles = results.flat();

  if (subtitles.length === 0) {
    console.log(
      `[subtitles] khong nguon nao co ban nao cho ${imdbid}${
        season ? `:${season}:${episode}` : ""
      }`
    );
    return null;
  }

  const langOf = (s) => isoCodeMapping[s.lang] || s.lang;
  const matching = (langCode) => subtitles.filter((s) => langOf(s) === langCode);

  // Xep hang uu tien roi tra ve ca danh sach, khong chi mot ban. Nha cung cap co the
  // liet ke mot ban ma tai ve lai hong, luc do ben tai se tu chuyen sang ban ke tiep.
  const ranked = [];
  const seen = new Set();
  const push = (list) => {
    for (const s of list) {
      if (seen.has(s.url)) continue;
      seen.add(s.url);
      ranked.push(s);
    }
  };
  push(matching(newisocode)); // 1. San co dung ngon ngu dich, khoi phai dich lai
  push(matching("en")); // 2. Tieng Anh de dich
  push(subtitles); // 3. Con lai, con hon khong co gi

  const chosen = ranked.slice(0, MAX_CANDIDATES);
  console.log(
    `[subtitles] ${chosen.length} ban du phong theo thu tu: ` +
      chosen.map((s) => `${s.lang}/${s.source}`).join(", ")
  );
  return chosen.map((s) => ({ url: s.url, lang: s.lang, source: s.source }));
};

module.exports = { getsubtitles, downloadSubtitles, isServableSubtitle };
