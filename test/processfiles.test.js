const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ROOT, stubModule, srt } = require("./helpers");

// Ban gia cho moi thu processfiles.js cham toi ben ngoai: tai phu de, co so du lieu
// va goi model. Phai dat truoc khi require processfiles.
class QuotaError extends Error {}
let translate = async (texts) => texts.map((t) => `VI:${t}`);
const translateCalls = [];
stubModule("./translateProvider", {
  QuotaError,
  translateText: async (texts, ...rest) => {
    translateCalls.push(texts.slice());
    return translate(texts, ...rest);
  },
});

let downloadedPath = null;
stubModule("./opensubtitles", {
  downloadSubtitles: async () => [downloadedPath],
});

const dbCalls = [];
const recordDb =
  (name, result) =>
  async (...args) => {
    dbCalls.push([name, ...args]);
    return result;
  };
stubModule("./connection", {
  addToTranslationQueue: recordDb("addToTranslationQueue"),
  deletetranslationQueue: recordDb("deletetranslationQueue"),
  checkseries: recordDb("checkseries", false),
  addseries: recordDb("addseries"),
  checksubtitle: recordDb("checksubtitle", false),
  addsubtitle: recordDb("addsubtitle"),
});
stubModule("./subtitles", { createOrUpdateMessageSub: async () => {} });

const { parseSrt, formatSrt, startTranslation } = require(path.join(ROOT, "processfiles"));

describe("parseSrt", () => {
  const sample = srt([
    ["1", "00:00:01,000 --> 00:00:02,000", "Hello"],
    ["2", "00:00:03,000 --> 00:00:04,000", "Two\nlines"],
    ["3", "00:00:05,000 --> 00:00:06,000", "Bye"],
  ]);

  test("reads counter, timecode and multi line text", () => {
    assert.deepEqual(parseSrt(sample), [
      { counter: "1", timecode: "00:00:01,000 --> 00:00:02,000", text: "Hello" },
      { counter: "2", timecode: "00:00:03,000 --> 00:00:04,000", text: "Two\nlines" },
      { counter: "3", timecode: "00:00:05,000 --> 00:00:06,000", text: "Bye" },
    ]);
  });

  test("same blocks with or without a trailing newline", () => {
    const expected = parseSrt(sample);
    assert.deepEqual(parseSrt(sample.trimEnd()), expected);
    assert.deepEqual(parseSrt(sample + "\n\n\n"), expected);
  });

  test("handles CRLF and lone CR line endings", () => {
    const expected = parseSrt(sample);
    assert.deepEqual(parseSrt(sample.replace(/\n/g, "\r\n")), expected);
    assert.deepEqual(parseSrt(sample.replace(/\n/g, "\r")), expected);
  });

  test("tolerates extra blank lines between blocks", () => {
    assert.equal(parseSrt(sample.replace(/\n\n/g, "\n\n\n\n")).length, 3);
  });

  test("skips blocks with no timecode or no text", () => {
    const content = [
      "garbage header",
      "",
      "1\n00:00:01,000 --> 00:00:02,000\nKept",
      "",
      "2\n00:00:03,000 --> 00:00:04,000",
      "",
      "3\n00:00:05,000 --> 00:00:06,000\nAlso kept",
    ].join("\n");
    assert.deepEqual(
      parseSrt(content).map((b) => b.text),
      ["Kept", "Also kept"]
    );
  });

  test("numbers a block that has no counter line", () => {
    const blocks = parseSrt("00:00:01,000 --> 00:00:02,000\nNo counter\n");
    assert.equal(blocks[0].counter, "1");
    assert.equal(blocks[0].text, "No counter");
  });

  test("returns nothing for an empty file", () => {
    assert.deepEqual(parseSrt(""), []);
  });

  // Dong chi co dau cach giua hai khoi tung khong duoc coi la dong trong, nen khoi sau
  // (ca so thu tu lan timecode) bi dan vao loi thoai cua khoi truoc.
  test("treats a line of only spaces as a blank separator", () => {
    const messy = sample
      .replace("Hello\n\n", "Hello\n \t\n")
      .replace("lines\n\n", "lines\n  \n\n");
    assert.deepEqual(parseSrt(messy), parseSrt(sample));
  });

  test("strips a byte order mark before the first counter", () => {
    assert.equal(parseSrt("\uFEFF" + sample)[0].counter, "1");
  });

  test("keeps skipped counters as they are", () => {
    const content = sample.replace(/^2$/m, "7").replace(/^3$/m, "42");
    assert.deepEqual(parseSrt(content).map((b) => b.counter), ["1", "7", "42"]);
  });
});

describe("formatSrt", () => {
  const counters = ["1", "2", "3"];
  const timecodes = [
    "00:00:01,000 --> 00:00:02,000",
    "00:00:03,000 --> 00:00:04,000",
    "00:00:05,000 --> 00:00:06,000",
  ];

  test("round trips through parseSrt with the same timecodes", () => {
    const blocks = parseSrt(formatSrt(counters, timecodes, ["Mot", "Hai\ndong", "Ba"]));
    assert.deepEqual(blocks.map((b) => b.timecode), timecodes);
    assert.deepEqual(blocks.map((b) => b.text), ["Mot", "Hai\ndong", "Ba"]);
  });

  test("falls back to the original line instead of shifting the next one up", () => {
    const out = formatSrt(counters, timecodes, ["Mot", undefined, "Ba"], ["One", "Two", "Three"]);
    assert.ok(!out.includes("undefined"));
    assert.deepEqual(parseSrt(out).map((b) => b.text), ["Mot", "Two", "Ba"]);
  });
});

describe("startTranslation", () => {
  const cwd = process.cwd();
  let tmp;

  const lines = ["a", "b", "c", "d", "e"];
  const timecodes = lines.map(
    (_, i) => `00:00:0${i},000 --> 00:00:0${i},900`
  );

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "finnsub-test-"));
    process.chdir(tmp);
    process.env.TRANSLATE_BATCH_PAUSE_MS = "0";
  });

  after(() => {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(path.join(tmp, "subtitles"), { recursive: true, force: true });
    downloadedPath = "subtitles/download/tt1/source.srt";
    fs.mkdirSync(path.dirname(downloadedPath), { recursive: true });
    fs.writeFileSync(
      downloadedPath,
      srt(lines.map((text, i) => [String(i + 1), timecodes[i], text]))
    );
    translateCalls.length = 0;
    dbCalls.length = 0;
    translate = async (texts) => texts.map((t) => `VI:${t}`);
    process.env.TRANSLATE_BATCH_SIZE = "2";
  });

  const run = () =>
    startTranslation([{}], "tt1", null, null, "vie", "Google Gemini", "k", "u", "m");
  const output = () =>
    parseSrt(
      fs.readFileSync("subtitles/Google Gemini/vie/tt1/tt1-translated-1.srt", "utf8")
    );

  test("splits the file into batches of TRANSLATE_BATCH_SIZE", async () => {
    assert.equal(await run(), true);
    assert.deepEqual(translateCalls, [["a", "b"], ["c", "d"], ["e"]]);
  });

  test("writes translations against the original counters and timecodes", async () => {
    await run();
    assert.deepEqual(
      output(),
      lines.map((text, i) => ({
        counter: String(i + 1),
        timecode: timecodes[i],
        text: `VI:${text}`,
      }))
    );
    assert.ok(dbCalls.some(([name]) => name === "addsubtitle"));
  });

  test("halves a failing batch and keeps a bad line untranslated", async () => {
    process.env.TRANSLATE_BATCH_SIZE = "4";
    translate = async (texts) => {
      if (texts.includes("c")) throw new Error("bad JSON");
      return texts.map((t) => `VI:${t}`);
    };

    assert.equal(await run(), true);
    assert.deepEqual(translateCalls, [
      ["a", "b", "c", "d"],
      ["a", "b"],
      ["c", "d"],
      ["c"],
      ["d"],
      ["e"],
    ]);
    assert.deepEqual(
      output().map((b) => [b.timecode, b.text]),
      [
        [timecodes[0], "VI:a"],
        [timecodes[1], "VI:b"],
        [timecodes[2], "c"],
        [timecodes[3], "VI:d"],
        [timecodes[4], "VI:e"],
      ]
    );
  });

  test("gives up without halving on a quota error", async () => {
    translate = async () => {
      throw new QuotaError("quota");
    };
    assert.equal(await run(), false);
    assert.deepEqual(translateCalls, [["a", "b"]]);
    assert.equal(fs.existsSync("subtitles/Google Gemini"), false);
  });

  test("refuses to save when no line could be translated", async () => {
    translate = async () => {
      throw new Error("bad JSON");
    };
    assert.equal(await run(), false);
    assert.equal(
      fs.existsSync("subtitles/Google Gemini/vie/tt1/tt1-translated-1.srt"),
      false
    );
    assert.ok(!dbCalls.some(([name]) => name === "addsubtitle"));
  });

  test("cleans up the downloaded file and the queue entry", async () => {
    await run();
    assert.equal(fs.existsSync(downloadedPath), false);
    assert.equal(fs.existsSync("subtitles/download"), false);
    assert.ok(dbCalls.some(([name]) => name === "deletetranslationQueue"));
  });
});
