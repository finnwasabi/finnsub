/**
 * Required dependencies
 */
const opensubtitles = require("./opensubtitles");
const connection = require("./connection");
const fs = require("fs").promises;
const { translateText, QuotaError } = require("./translateProvider");
const { createOrUpdateMessageSub } = require("./subtitles");

/**
 * Doc file .srt thanh tung khoi. Ban cu doc theo trang thai tung dong va day cau thoai
 * cuoi vao lo o moi dong trong, roi day them mot lan nua o cuoi file, nen tuy file co
 * xuong dong cuoi hay khong ma thua hoac thieu mot cau. Luc ghi ra thi no duyet theo so
 * khoi goc, nen lech mot cai la toan bo phan sau lech thoai ma khong bao loi gi.
 */
function parseSrt(content) {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = [];

  for (const raw of normalized.split(/\n{2,}/)) {
    const lines = raw.split("\n").filter((line) => line.trim() !== "");
    const timecodeAt = lines.findIndex((line) => line.includes("-->"));
    if (timecodeAt === -1 || timecodeAt === lines.length - 1) continue;

    blocks.push({
      counter:
        timecodeAt > 0 ? lines[timecodeAt - 1].trim() : String(blocks.length + 1),
      timecode: lines[timecodeAt].trim(),
      text: lines.slice(timecodeAt + 1).join("\n"),
    });
  }

  return blocks;
}

class SubtitleProcessor {
  constructor() {
    this.subcounts = [];
    this.timecodes = [];
    this.texts = [];
    this.translatedSubtitle = [];
    this.count = 0;
    this.untranslatedCount = 0;
  }

  async processSubtitles(
    filepath,
    imdbid,
    season = null,
    episode = null,
    oldisocode,
    provider,
    apikey,
    base_url,
    model_name
  ) {
    try {
      const originalSubtitleFilePath = filepath[0];
      const originalSubtitleContent = await fs.readFile(
        originalSubtitleFilePath,
        { encoding: "utf-8" }
      );

      const blocks = parseSrt(originalSubtitleContent);
      if (blocks.length === 0) {
        throw new Error("Subtitle file has no readable blocks");
      }

      this.subcounts = blocks.map((block) => block.counter);
      this.timecodes = blocks.map((block) => block.timecode);
      this.texts = blocks.map((block) => block.text);

      // Kich thuoc lo doi duoc bang bien moi truong. Nha cung cap tinh han muc theo so
      // luot goi moi ngay chu khong theo so chu, nen lo cang lon cang do ton han muc,
      // doi lai lo lon thi model nho de tra ve JSON vo hoac thieu dong.
      const batchSize = Number(
        process.env.TRANSLATE_BATCH_SIZE ||
          (provider === "ChatGPT API" ? 50 : 200)
      );
      const batchPause = Number(process.env.TRANSLATE_BATCH_PAUSE_MS || 4000);

      for (let start = 0; start < this.texts.length; start += batchSize) {
        const batch = this.texts.slice(start, start + batchSize);
        await this.translateBatch(
          batch,
          oldisocode,
          provider,
          apikey,
          base_url,
          model_name
        );

        if (start + batchSize < this.texts.length && batchPause > 0) {
          // Nghi giua cac lo: goi lien tiep khong nghi thi nha cung cap tu choi bang 429
          // ngay ca khi chua cham tran ngay.
          await new Promise((resolve) => setTimeout(resolve, batchPause));
        }
      }

      // Save translated subtitles
      try {
        await this.saveTranslatedSubs(
          imdbid,
          season,
          episode,
          oldisocode,
          provider
        );
        console.log("Subtitles saved successfully");
      } catch (error) {
        console.error("Error saving translated subtitles:", error);
        throw error;
      }
    } catch (error) {
      console.error("Error:", error.message);
      throw error;
    }
  }

  async translateBatch(
    subtitleBatch,
    oldisocode,
    provider,
    apikey,
    base_url,
    model_name
  ) {
    try {
      const translations = await translateText(
        subtitleBatch,
        oldisocode,
        provider,
        apikey,
        base_url,
        model_name
      );

      translations.forEach((translatedText) => {
        this.translatedSubtitle.push(translatedText);
      });

      console.log(`Batch translation completed (${subtitleBatch.length} lines)`);
    } catch (error) {
      // Het han muc thi cat nho ra cung vo ich, chi ton them luot goi. Bo cuoc luon,
      // de lan sau dich lai tu dau con hon luu mot ban dich do dang.
      if (error instanceof QuotaError) {
        throw error;
      }

      // Con lai deu la loi cua mot lo cu the: model tra ve JSON vo, hoac so dong tra ve
      // khong khop. Chia doi lo roi thu lai thay vi bo ca tap: mot cau thoai kho nuot
      // khong duoc keo theo 599 cau con lai.
      if (subtitleBatch.length > 1) {
        const middle = Math.ceil(subtitleBatch.length / 2);
        console.log(
          `Batch of ${subtitleBatch.length} failed (${error.message}), splitting in two`
        );
        await this.translateBatch(
          subtitleBatch.slice(0, middle),
          oldisocode,
          provider,
          apikey,
          base_url,
          model_name
        );
        await this.translateBatch(
          subtitleBatch.slice(middle),
          oldisocode,
          provider,
          apikey,
          base_url,
          model_name
        );
        return;
      }

      // Mot dong don ma van hong: giu nguyen ban goc. Nguoi xem doc mot cau tieng Anh
      // giua chung con hon toan bo phan sau bi lech moc thoi gian.
      console.error("Line kept untranslated:", error.message);
      this.translatedSubtitle.push(subtitleBatch[0]);
      this.untranslatedCount++;
    }
  }

  async saveTranslatedSubs(
    imdbid,
    season = null,
    episode = null,
    oldisocode,
    provider
  ) {
    try {
      // Define directory path based on content type and provider
      const dirPath =
        season !== null && episode !== null
          ? `subtitles/${provider}/${oldisocode}/${imdbid}/season${season}`
          : `subtitles/${provider}/${oldisocode}/${imdbid}`;

      // Create directory if it doesn't exist
      await fs.mkdir(dirPath, { recursive: true });

      // Create file path and determine content type
      const type = season && episode ? "series" : "movie";
      const newSubtitleFilePath =
        season && episode
          ? `${dirPath}/${imdbid}-translated-${episode}-1.srt`
          : `${dirPath}/${imdbid}-translated-1.srt`;

      // Build subtitle content
      const output = [];
      for (let i = 0; i < this.subcounts.length; i++) {
        // Neu vi ly do nao do thieu ban dich cho mot khoi thi giu nguyen cau goc, chu
        // khong de "undefined" roi vao file phu de.
        const line =
          this.translatedSubtitle[i] !== undefined
            ? this.translatedSubtitle[i]
            : this.texts[i];
        output.push(this.subcounts[i], this.timecodes[i], line, "");
      }

      if (
        this.untranslatedCount > 0 &&
        this.untranslatedCount === this.translatedSubtitle.length
      ) {
        throw new Error(
          "Nothing could be translated, refusing to save a copy of the original"
        );
      }

      if (this.untranslatedCount > 0) {
        console.log(
          `${this.untranslatedCount} of ${this.translatedSubtitle.length} lines kept in the original language`
        );
      }

      // Save file and update database
      await fs.writeFile(newSubtitleFilePath, output.join("\n"), { flag: "w" });

      if (!(await connection.checkseries(imdbid))) {
        await connection.addseries(imdbid, type);
      }

      // Ban ghi chi duoc tao o day, sau khi file dich that su nam tren dia. Truoc day
      // index.js tao no ngay luc xep hang, nen dich hong la ban ghi ket lai vinh vien.
      if (
        !(await connection.checksubtitle(
          imdbid,
          season,
          episode,
          newSubtitleFilePath,
          oldisocode
        ))
      ) {
        await connection.addsubtitle(
          imdbid,
          type,
          season,
          episode,
          newSubtitleFilePath,
          oldisocode
        );
      }

      console.log(
        `Subtitle translation and saving completed: ${newSubtitleFilePath}`
      );
    } catch (error) {
      console.error("Error saving translated subtitles:", error);
      throw error;
    }
  }
}

/**
 * Starts the subtitle translation process
 * @param {Object[]} subtitles - Array of subtitle objects to translate
 * @param {string} imdbid - IMDB ID of the media
 * @param {string|null} season - Season number (optional)
 * @param {string|null} episode - Episode number (optional)
 * @param {string} oldisocode - ISO code of the original language
 * @returns {Promise<boolean>} - Returns true on success, false otherwise
 */
async function startTranslation(
  subtitles,
  imdbid,
  season = null,
  episode = null,
  oldisocode,
  provider,
  apikey,
  base_url,
  model_name
) {
  let filepaths = [];
  try {
    const processor = new SubtitleProcessor();
    filepaths = await opensubtitles.downloadSubtitles(
      subtitles,
      imdbid,
      season,
      episode,
      oldisocode
    );

    if (filepaths && filepaths.length > 0) {
      await connection.addToTranslationQueue(
        imdbid,
        season,
        episode,
        filepaths.length,
        oldisocode,
        provider,
        apikey
      );
      await processor.processSubtitles(
        filepaths,
        imdbid,
        season,
        episode,
        oldisocode,
        provider,
        apikey,
        base_url,
        model_name
      );
      return true;
    }
    return false;
  } catch (error) {
    console.error("General catch error:", error);
    return false;
  } finally {
    // Cleanup: Delete downloaded original subtitle files
    for (const fp of filepaths) {
      try {
        await fs.unlink(fp);
        console.log(`Cleaned up downloaded file: ${fp}`);
      } catch (unlinkError) {
        console.error(`Error cleaning up file ${fp}:`, unlinkError);
      }
      // Ban tieng Anh duoc tai ve mot cay thu muc tam rieng. Xoa file xong ma khong don
      // thu muc thi con lai mot cay rong lon dan theo tung bo phim.
      let dir = fp.slice(0, fp.lastIndexOf("/"));
      while (dir && dir !== "subtitles") {
        try {
          await fs.rmdir(dir);
        } catch (rmError) {
          break; // con file khac trong do, dung lai
        }
        dir = dir.slice(0, dir.lastIndexOf("/"));
      }
    }
    // Cleanup: Delete entry from translation queue in DB
    try {
      await connection.deletetranslationQueue(
        imdbid,
        season,
        episode,
        oldisocode
      );
      console.log("Cleaned up translation queue entry in DB.");
    } catch (dbCleanupError) {
      console.error("Error cleaning up DB translation queue entry:", dbCleanupError);
    }
  }
}

module.exports = { startTranslation, parseSrt };
