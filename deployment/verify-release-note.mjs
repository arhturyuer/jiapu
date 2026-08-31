#!/usr/bin/env node

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const releaseInfo = require('../miniprogram/utils/release-info');
const releaseNotes = require('../miniprogram/config/release-notes');
const version = String(process.argv[2] || '').trim();

try {
  const notes = releaseInfo.validateReleaseNotes(releaseNotes);
  const latest = notes[0];
  if (!latest) throw new Error('版本记录为空；请先在 miniprogram/config/release-notes.js 顶部新增本次发布记录');
  if (version !== latest.version) throw new Error('上传版本 ' + version + ' 与最新版本记录 ' + latest.version + ' 不一致');
  process.stdout.write(latest.summary);
} catch (error) {
  console.error(error.message || '版本记录校验失败');
  process.exit(2);
}
