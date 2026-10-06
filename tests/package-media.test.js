const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const miniprogramRoot = path.join(root, 'miniprogram');
const mediaExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp3', '.wav', '.aac', '.m4a', '.ogg']);
const maxMediaBytes = 200000;

function mediaFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(function (entry) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return mediaFiles(target);
    return mediaExtensions.has(path.extname(entry.name).toLowerCase()) ? [target] : [];
  });
}

function jpegDimensions(filePath) {
  const bytes = fs.readFileSync(filePath);
  let offset = 2;
  while (offset < bytes.length) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    const length = bytes.readUInt16BE(offset);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  throw new Error('无法读取 JPEG 尺寸');
}

test('代码包内每个图片和音频资源均不超过微信质量扫描的 200 KB 限制', function () {
  const oversized = mediaFiles(miniprogramRoot).filter(function (filePath) {
    return fs.statSync(filePath).size > maxMediaBytes;
  });
  assert.deepEqual(oversized, []);
});

test('代码包内图片和音频总量保守控制在 200000 字节内', function () {
  const total = mediaFiles(miniprogramRoot).reduce(function (bytes, filePath) {
    return bytes + fs.statSync(filePath).size;
  }, 0);
  assert.ok(total <= maxMediaBytes, '图片和音频总量为 ' + total + ' 字节');
});

test('当前单主包源码总量低于 1500000 字节，编译包另由开发者工具核验', function () {
  function totalBytes(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).reduce(function (bytes, entry) {
      const target = path.join(directory, entry.name);
      return bytes + (entry.isDirectory() ? totalBytes(target) : fs.statSync(target).size);
    }, 0);
  }
  const total = totalBytes(miniprogramRoot);
  assert.ok(total < 1500000, '主包源码总量为 ' + total + ' 字节');
});

test('分享卡品牌兜底图为 5:4 的轻量 JPEG', function () {
  const fallback = path.join(miniprogramRoot, 'images/share/brand-fallback.jpg');
  assert.equal(fs.existsSync(fallback), true);
  assert.ok(fs.statSync(fallback).size <= 180 * 1024);
  assert.deepEqual(jpegDimensions(fallback), { width: 750, height: 600 });
});

test('有谱介绍分享图为 5:4 的轻量 JPEG', function () {
  const intro = path.join(miniprogramRoot, 'images/share/youpu-intro.jpg');
  assert.ok(fs.statSync(intro).size <= 180 * 1024);
  assert.deepEqual(jpegDimensions(intro), { width: 750, height: 600 });
});
