const test = require("node:test");
const assert = require("node:assert/strict");
const { nextSlot, pickSlot, markExhausted, slotOf } = require("../translateProvider");

// Moi test dung ten model rieng vi danh dau het han muc la trang thai chung trong module.
const keys = ["k1", "k2"];

test("nextSlot: doi khoa truoc, ha model sau", () => {
  const models = ["n-37", "n-36", "n-35"];
  const order = [];
  let slot = { keyIndex: 0, modelIndex: 0 };
  for (let i = 0; i < 5; i++) {
    slot = nextSlot(keys, models, slot.keyIndex, slot.modelIndex);
    order.push(`${slot.keyIndex}/${models[slot.modelIndex]}`);
  }
  assert.deepEqual(order, ["1/n-37", "0/n-36", "1/n-36", "0/n-35", "1/n-35"]);
});

test("nextSlot: bo qua cap da het, khong bo ca model", () => {
  const models = ["s-a", "s-b"];
  markExhausted(slotOf(1, "s-a"));
  assert.deepEqual(nextSlot(keys, models, 0, 0), { keyIndex: 0, modelIndex: 1 });
});

test("nextSlot: het sach thi tra null", () => {
  const models = ["x-a", "x-b"];
  for (const k of [0, 1]) for (const m of models) markExhausted(slotOf(k, m));
  assert.equal(nextSlot(keys, models, 0, 0), null);
});

test("pickSlot: cap hien tai con dung thi giu nguyen", () => {
  assert.deepEqual(pickSlot(keys, ["p-a"], 1, 0), { keyIndex: 1, modelIndex: 0 });
});

test("pickSlot: cap hien tai da het thi chuyen sang cap ke tiep", () => {
  const models = ["q-a", "q-b"];
  markExhausted(slotOf(0, "q-a"));
  assert.deepEqual(pickSlot(keys, models, 0, 0), { keyIndex: 1, modelIndex: 0 });
});

test("pickSlot: chi so vuot qua danh sach thi kep ve cuoi", () => {
  assert.deepEqual(pickSlot(["k1"], ["r-a"], 5, 9), { keyIndex: 0, modelIndex: 0 });
});

test("pickSlot: het sach thi van tra cap hien tai de ben goi bao loi dung", () => {
  const models = ["w-a"];
  markExhausted(slotOf(0, "w-a"));
  markExhausted(slotOf(1, "w-a"));
  assert.deepEqual(pickSlot(keys, models, 1, 0), { keyIndex: 1, modelIndex: 0 });
});
