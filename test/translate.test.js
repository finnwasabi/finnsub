const { test, describe, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ROOT, stubModule } = require("./helpers");

// Cac bien nay duoc doc luc nap module, nen phai dat truoc khi require.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "finnsub-test-"));
process.env.QUOTA_USAGE_FILE = path.join(tmp, "quota-usage.json");
process.env.TRANSLATE_RETRY_BASE_MS = "0";
process.env.TRANSLATE_RATE_WAIT_MS = "0";
process.env.TRANSLATE_MAX_RETRIES = "3";
process.env.TRANSLATE_EXTRA_API_KEYS = "";

// Model gia: moi luot goi ghi lai (khoa, model, cac dong gui di) roi tra ve thu ma
// test dang can.
let reply = () => "{}";
const calls = [];
stubModule("openai", function FakeOpenAI({ apiKey }) {
  this.chat = {
    completions: {
      create: async ({ model, messages }) => {
        const input = JSON.parse(messages[0].content.split("Input:\n")[1]);
        const texts = input.texts.map((t) => t.text);
        calls.push({ key: apiKey, model, texts });
        return { choices: [{ message: { content: reply(texts, model, apiKey) } }] };
      },
    },
  };
});

const { parseJsonLoose, translateText, QuotaError } = require(
  path.join(ROOT, "translateProvider")
);

const ok = (texts) =>
  JSON.stringify({ texts: texts.map((text, index) => ({ index, text: `VI:${text}` })) });
const quotaError = () => Object.assign(new Error("429 no body"), { status: 429 });

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("parseJsonLoose", () => {
  test("parses plain JSON", () => {
    assert.deepEqual(parseJsonLoose('{"texts":[]}'), { texts: [] });
  });

  test("strips a ```json fence", () => {
    assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  });

  test("ignores prose around the object", () => {
    assert.deepEqual(parseJsonLoose('Here you go: {"a":1} hope it helps'), { a: 1 });
  });

  test("escapes raw line breaks inside strings", () => {
    assert.deepEqual(parseJsonLoose('{"a":"one\ntwo"}'), { a: "one\ntwo" });
  });

  test("keeps escaped quotes while escaping line breaks", () => {
    assert.deepEqual(parseJsonLoose('{"a":"say \\"hi\\"\nthere"}'), {
      a: 'say "hi"\nthere',
    });
  });

  test("drops trailing commas", () => {
    assert.deepEqual(parseJsonLoose('{"a":[1,2,],}'), { a: [1, 2] });
  });

  test("throws on output that is not JSON at all", () => {
    assert.throws(() => parseJsonLoose("sorry, I cannot help with that"));
    assert.throws(() => parseJsonLoose(""));
  });
});

describe("translateText", () => {
  beforeEach(() => {
    calls.length = 0;
    reply = ok;
  });

  // Model bi danh dau het han muc duoc nho trong module, nen moi test dung ten model
  // rieng de khong anh huong nhau.
  const run = (texts, models, keys = "k1") =>
    translateText(texts, "vi", "Google Gemini", keys, "http://fake", models);

  test("returns translations in input order even if the model reorders them", async () => {
    reply = () =>
      JSON.stringify({ texts: [{ index: 1, text: "VI:b" }, { index: 0, text: "VI:a" }] });
    assert.deepEqual(await run(["a", "b"], "order"), ["VI:a", "VI:b"]);
  });

  test("accepts a fenced reply with raw line breaks", async () => {
    reply = () => '```json\n{"texts":[{"index":0,"text":"dong 1\ndong 2"}]}\n```';
    assert.deepEqual(await run(["line 1\nline 2"], "fenced"), ["dong 1\ndong 2"]);
  });

  test("re-requests only the line the model dropped", async () => {
    let n = 0;
    reply = (texts) => (++n === 1 ? ok(texts.slice(0, -1)) : ok(texts));
    assert.deepEqual(await run(["a", "b"], "mismatch-once"), ["VI:a", "VI:b"]);
    assert.deepEqual(calls.map((c) => c.texts), [["a", "b"], ["b"]]);
  });

  test("gives up after max retries on a persistent mismatch", async () => {
    reply = (texts) => ok(texts.slice(0, -1));
    await assert.rejects(run(["a", "b"], "mismatch-always"), /no line could be recovered/);
    assert.equal(calls.length, 3);
  });

  test("an unparseable reply fails with an ordinary error, not a quota error", async () => {
    reply = () => "not json";
    await assert.rejects(run(["a"], "garbage"), (error) => {
      assert.ok(!(error instanceof QuotaError));
      return true;
    });
    assert.equal(calls.length, 3);
  });

  test("on quota, retries the same model once, then the next key before the next model", async () => {
    reply = (texts, model, key) => {
      if (model === "best" && key === "k1") throw quotaError();
      return ok(texts);
    };
    assert.deepEqual(await run(["a"], "best, worse", "k1, k2"), ["VI:a"]);
    assert.deepEqual(
      calls.map((c) => `${c.key}/${c.model}`),
      ["k1/best", "k1/best", "k2/best"]
    );
  });

  test("throws QuotaError once every key and model is spent", async () => {
    reply = () => {
      throw quotaError();
    };
    await assert.rejects(run(["a"], "q1, q2"), QuotaError);
  });
});
