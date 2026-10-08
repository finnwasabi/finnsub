const path = require("path");

const ROOT = path.join(__dirname, "..");

/**
 * Thay mot module bang ban gia truoc khi code that require no. Nho vay test khong
 * can co so du lieu, mang hay khoa API that.
 */
function stubModule(id, exports) {
  const resolved = require.resolve(
    id.startsWith(".") ? path.join(ROOT, id) : id
  );
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  };
}

function srt(blocks) {
  return blocks
    .map(([counter, timecode, text]) => `${counter}\n${timecode}\n${text}\n`)
    .join("\n");
}

module.exports = { ROOT, stubModule, srt };
