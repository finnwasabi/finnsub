/**
 * Required dependencies
 */
const opensubtitles = require("./opensubtitles");
const connection = require("./connection");
const fs = require("fs").promises;
const { translateText, QuotaError } = require("./translateProvider");
const { createOrUpdateMessageSub } = require("./subtitles");

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
      const lines = originalSubtitleContent.split("\n");

      // SUA TAI CHO: goc la 60. Han muc mien phi cua Gemini la 20 request moi phut, ma mot tap
      // 600 dong voi batch 60 la hon 10 luot goi lien tiep, cong retry cua thu vien OpenAI
      // la vuot tran. Batch 200 giam so luot goi xuong con mot phan ba.
      const batchSize = provider === "ChatGPT API" ? 50 : 200;
      let subtitleBatch = [];
      let currentBlock = {
        iscount: true,
        istimecode: false,
        istext: false,
        textcount: 0,
      };

      // Process subtitle file line by line
      for (const line of lines) {
        if (line.trim() === "") {
          currentBlock = {
            iscount: true,
            istimecode: false,
            istext: false,
            textcount: 0,
          };

          if (this.texts.length > 0) {
            subtitleBatch.push(this.texts[this.texts.length - 1]);
          }

          // Translate when batch size is reached
          if (subtitleBatch.length === batchSize) {
            try {
              await this.translateBatch(
                subtitleBatch,
                oldisocode,
                provider,
                apikey,
                base_url,
                model_name
              );
              subtitleBatch = [];
              // SUA TAI CHO: nghi 4 giay giua cac batch. Khong co dong nay thi cac luot goi
              // di lien nhau va dinh 429, luc do addon bo do ban dich giua chung.
              await new Promise((r) => setTimeout(r, 4000));
            } catch (error) {
              console.error("Batch translation error: ", error);
              throw error;
            }
          }
          continue;
        }

        if (currentBlock.iscount) {
          this.subcounts.push(line);
          currentBlock = {
            iscount: false,
            istimecode: true,
            istext: false,
            textcount: 0,
          };
          continue;
        }

        if (currentBlock.istimecode) {
          this.timecodes.push(line);
          currentBlock = {
            iscount: false,
            istimecode: false,
            istext: true,
            textcount: 0,
          };
          continue;
        }

        if (currentBlock.istext) {
          if (currentBlock.textcount === 0) {
            this.texts.push(line);
          } else {
            this.texts[this.texts.length - 1] += "\n" + line;
          }
          currentBlock.textcount++;
        }
      }

      // Process remaining batch
      if (subtitleBatch.length > 0) {
        try {
          subtitleBatch.push(this.texts[this.texts.length - 1]);
          await this.translateBatch(
            subtitleBatch,
            oldisocode,
            provider,
            apikey,
            base_url,
            model_name
          );
        } catch (error) {
          console.log("Subtitle batch error: ", error);
          throw error;
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
        output.push(
          this.subcounts[i],
          this.timecodes[i],
          this.translatedSubtitle[i],
          ""
        );
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

module.exports = { startTranslation };
