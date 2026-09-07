const Queue = require("better-queue");
const processfiles = require("../processfiles");

const translationQueue = new Queue(
  async function (job, cb) {
    try {
      const {
        subs,
        imdbid,
        season,
        episode,
        oldisocode,
        provider,
        apikey,
        base_url,
        model_name,
      } = job;

      console.log("Processing subtitles:", subs);

      // Keep as is
      const result = await processfiles.startTranslation(
        subs,
        imdbid,
        season,
        episode,
        oldisocode,
        provider,
        apikey,
        base_url,
        model_name
      );

      // startTranslation tra ve false khi that bai. Truoc day chuyen no vao cb(null, ...)
      // nen hang doi luon tuong la xong, va co che thu lai cua no chua bao gio chay.
      if (!result) {
        return cb(new Error("Translation failed"));
      }

      cb(null, result);
    } catch (error) {
      console.error("Queue error:", error);
      cb(error);
    }
  },
  {
    concurrent: 1, // Reduce to 1 process initially
    // Khong thu lai mu quang: phan lon that bai la het han muc theo NGAY cua nha cung
    // cap, thu lai sau 3 giay chi dot them han muc. Dot 3 se phan loai loi roi thu lai
    // dung cho dang dang.
    maxRetries: 0,
  }
);

module.exports = translationQueue;
