const test = require("node:test");
const assert = require("node:assert/strict");
const { parseJsonLoose, salvageItems, toLines, translationSchema } = require("../translateProvider");

const ok = `{"texts":[{"index":0,"text":"Mot"},{"index":1,"text":"Hai"},{"index":2,"text":"Ba"}]}`;
const read = (raw, count) => toLines(parseJsonLoose(raw), count);

test("JSON chuan, thu tu dao duoc xep lai theo index", () => {
  assert.deepEqual(read(ok, 3), ["Mot", "Hai", "Ba"]);
  const reversed = `{"texts":[{"index":2,"text":"Ba"},{"index":0,"text":"Mot"},{"index":1,"text":"Hai"}]}`;
  assert.deepEqual(read(reversed, 3), ["Mot", "Hai", "Ba"]);
});

test("code fence nam giua chu thua truoc va sau", () => {
  assert.deepEqual(read("Here is the translation:\n```json\n" + ok + "\n```\nHope this helps!", 3), ["Mot", "Hai", "Ba"]);
  assert.deepEqual(read("Sure! " + ok + " Done.", 3), ["Mot", "Hai", "Ba"]);
});

test("Unexpected non-whitespace character after JSON: chi lay doi tuong dau", () => {
  assert.deepEqual(read(ok + '\n{"note":"x"}', 3), ["Mot", "Hai", "Ba"]);
});

test("Expected ',' after array element: nhat lai tung cap con lanh", () => {
  const raw = `{"texts":[{"index":0,"text":"Mot"} {"index":1,"text":"Hai"}{"text":"Ba","index":2}]}`;
  assert.throws(() => parseJsonLoose(raw));
  assert.deepEqual([...salvageItems(raw)].sort(), [[0, "Mot"], [1, "Hai"], [2, "Ba"]]);
});

test("thieu dong thi de trong, dong sau khong bi day len", () => {
  const raw = `{"texts":[{"index":0,"text":"Mot"},{"index":2,"text":"Ba"}]}`;
  assert.deepEqual(read(raw, 3), ["Mot", null, "Ba"]);
});

test("thua dong va index ngoai khoang bi bo qua", () => {
  const raw = `{"texts":[{"index":0,"text":"Mot"},{"index":1,"text":"Hai"},{"index":2,"text":"Ba"},{"index":3,"text":"Bon"}]}`;
  assert.deepEqual(read(raw, 3), ["Mot", "Hai", "Ba"]);
});

test("index trung thi bo trong ca dong do de hoi lai, khong doan", () => {
  const raw = `{"texts":[{"index":0,"text":"Mot"},{"index":0,"text":"Hai"},{"index":2,"text":"Ba"}]}`;
  assert.deepEqual(read(raw, 3), [null, null, "Ba"]);
  const broken = `{"texts":[{"index":0,"text":"Mot"} {"index":0,"text":"Hai"} {"index":1,"text":"Ba"}`;
  assert.deepEqual([...salvageItems(broken)], [[1, "Ba"]]);
});

test("mang chuoi tran khong co index thi khong ghep theo vi tri", () => {
  assert.deepEqual(read(`{"texts":["Mot","Hai","Ba"]}`, 3), [null, null, null]);
});

test("schema khoa dung so dong va khoang index cua lo", () => {
  const arr = translationSchema(5).json_schema.schema.properties.texts;
  assert.equal(arr.minItems, 5);
  assert.equal(arr.maxItems, 5);
  assert.equal(arr.items.properties.index.minimum, 0);
  assert.equal(arr.items.properties.index.maximum, 4);
});
