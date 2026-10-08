const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

process.env.QUOTA_USAGE_FILE = require("node:path").join(
  require("node:os").tmpdir(),
  `finnsub-quota-${process.pid}.json`
);
process.env.TRANSLATE_RETRY_BASE_MS = "1";

const {
  translateText,
  parseJsonLoose,
  salvageItems,
  toLines,
} = require("../translateProvider");

test("parses JSON wrapped in a code fence with a trailing comma", () => {
  const raw = '```json\n{"texts":[{"index":0,"text":"Xin chao"},]}\n```';
  assert.deepStrictEqual(parseJsonLoose(raw).texts[0].text, "Xin chao");
});

test("repairs raw line breaks and unescaped quotes inside strings", () => {
  const raw = '{"texts":[{"index":0,"text":"Anh ay noi "khong", roi\nbo di"},{"index":1,"text":"Ok"}]}';
  const parsed = parseJsonLoose(raw);
  assert.strictEqual(parsed.texts[0].text, 'Anh ay noi "khong", roi\nbo di');
  assert.strictEqual(parsed.texts[1].text, "Ok");
});

test("salvages complete items from output cut off mid way", () => {
  const raw = '{"texts":[{"index":0,"text":"Mot"},{"index":1,"text":"Hai"},{"index":2,"text":"Ba';
  assert.throws(() => parseJsonLoose(raw));
  const items = salvageItems(raw);
  assert.deepStrictEqual([...items], [[0, "Mot"], [1, "Hai"]]);
});

test("places lines by index and leaves gaps as null", () => {
  const lines = toLines({ texts: [{ index: 2, text: "c" }, { index: 0, text: "a" }] }, 3);
  assert.deepStrictEqual(lines, ["a", null, "c"]);
});

function mockServer(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const request = JSON.parse(body);
      calls.push(request);
      const { status, content } = handler(request, calls.length);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        status === 200
          ? JSON.stringify({
              choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
            })
          : JSON.stringify({ error: { message: content } })
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}/v1` }))
  );
}

const inputOf = (request) =>
  JSON.parse(request.messages[0].content.split("Input:\n")[1]).texts;

test("only re-requests the lines the model dropped", async () => {
  const { server, calls, url } = await mockServer((request, n) => {
    const texts = inputOf(request);
    if (n === 1) {
      // Truncated reply: the last line is lost.
      const ok = texts.slice(0, -1).map((t) => `{"index":${t.index},"text":"vi:${t.text}"}`);
      return { status: 200, content: `{"texts":[${ok.join(",")},{"index":${texts.length - 1},"text":"vi:` };
    }
    return {
      status: 200,
      content: JSON.stringify({ texts: texts.map((t) => ({ index: t.index, text: `vi:${t.text}` })) }),
    };
  });
  try {
    const out = await translateText(["a", "b", "c"], "vi", "Google Gemini", "k", url, "m1");
    assert.deepStrictEqual(out, ["vi:a", "vi:b", "vi:c"]);
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(inputOf(calls[1]).map((t) => t.text), ["c"]);
    assert.strictEqual(calls[0].response_format.type, "json_schema");
  } finally {
    server.close();
  }
});

test("falls back to json_object when the provider rejects a schema", async () => {
  const { server, calls, url } = await mockServer((request) => {
    if (request.response_format.type === "json_schema") {
      return { status: 400, content: "response_format json_schema is not supported" };
    }
    const texts = inputOf(request);
    return {
      status: 200,
      content: JSON.stringify({ texts: texts.map((t) => ({ index: t.index, text: t.text.toUpperCase() })) }),
    };
  });
  try {
    assert.deepStrictEqual(await translateText(["x"], "vi", "Groq", "k", url, "m2"), ["X"]);
    assert.deepStrictEqual(await translateText(["y"], "vi", "Groq", "k", url, "m2"), ["Y"]);
    // Schema is tried once, then remembered as unsupported.
    assert.deepStrictEqual(calls.map((c) => c.response_format.type), ["json_schema", "json_object", "json_object"]);
  } finally {
    server.close();
  }
});

test("a batch that never parses costs MAX_RETRIES calls, not more", async () => {
  const { server, calls, url } = await mockServer(() => ({ status: 200, content: "not json at all" }));
  try {
    await assert.rejects(translateText(["a", "b"], "vi", "Google Gemini", "k", url, "m3"));
    assert.strictEqual(calls.length, 3);
  } finally {
    server.close();
  }
});
