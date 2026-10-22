<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import type { JSONContent } from '@tiptap/vue-3';
import { callOps, getErrorMessage } from '../cloudbase';
import { stableStringify, storedDocument } from '../guide-document.js';
import GuideEditor from './GuideEditor.vue';
import GuidePreview from './GuidePreview.vue';
interface Draft { title: string; summary: string; sortOrder: number; related: string[]; body: JSONContent }
interface GuideRow { _id: string; slug: string; title: string; status: string; revision: number; sortOrder: number }
interface Guide extends GuideRow { draft: Draft; published: Draft | null }
interface Settings { draft: { title: string; summary: string }; published: { title: string; summary: string }; revision: number }
const rows = ref<GuideRow[]>([]);
const selected = ref<Guide | null>(null);
const draft = reactive<Draft>({ title: '', summary: '', sortOrder: 0, related: [], body: { type: 'doc', content: [{ type: 'paragraph' }] } });
const slug = ref('');
const images = ref<Record<string, string>>({});
const saved = ref('');
const creating = ref(false);
const settingsMode = ref(false);
const settings = ref<Settings | null>(null);
const settingsDraft = reactive({ title: '', summary: '' });
const settingsSaved = ref('');
const loading = ref(false);
const busy = ref(false);
const imageBusy = ref(false);
const error = ref('');
const notice = ref('');
const keyword = ref('');
const status = ref('active');
const preview = ref(false);
const pendingIds = new Map<string, string>();
let alive = true; let selectionRequest = 0;
const serialize = () => stableStringify({ slug: slug.value, draft: { ...draft, body: storedDocument(draft.body) } });
const articleDirty = computed(() => (creating.value || !!selected.value) && serialize() !== saved.value);
const settingsDirty = computed(() => !!settings.value && JSON.stringify(settingsDraft) !== settingsSaved.value);
const dirty = computed(() => articleDirty.value || settingsDirty.value);
const locked = computed(() => loading.value || busy.value || imageBusy.value);
const visibleRows = computed(() => rows.value.filter(row => (status.value === 'active' ? row.status !== 'deleted' : !status.value || row.status === status.value) && row.title.toLowerCase().includes(keyword.value.toLowerCase())).sort((a, b) => a.sortOrder - b.sortOrder || a.slug.localeCompare(b.slug)));
const relatedChoices = computed(() => rows.value.filter(row => (row.status !== 'deleted' || draft.related.includes(row.slug)) && row._id !== selected.value?._id));
const statusName = (value: string) => ({ draft: '草稿', published: '已发布', unpublished: '已下架', deleted: '回收站' }[value] || value);
function canLeave(): boolean { return !locked.value && (!dirty.value || window.confirm('有尚未保存的修改，确认放弃并离开？')); }
defineExpose({ canLeave });
function beforeUnload(event: BeforeUnloadEvent): void { if (dirty.value || busy.value || imageBusy.value) { event.preventDefault(); event.returnValue = ''; } }
async function loadAll(): Promise<void> {
  const items: GuideRow[] = []; let cursor = '';
  do {
    const result = await callOps<{ items: GuideRow[]; hasMore: boolean; nextCursor: string }>('guides.list', { pageSize: 100, cursor });
    items.push(...result.items); cursor = result.hasMore ? result.nextCursor : '';
    if (result.hasMore && (!cursor || items.length >= 2000)) throw new Error('指南列表超过查询上限');
  } while (cursor && alive);
  if (alive) rows.value = items;
}
async function refresh(): Promise<void> {
  loading.value = true; error.value = '';
  try { await loadAll(); } catch (err) { error.value = getErrorMessage(err, '指南列表加载失败'); } finally { loading.value = false; }
}
function fill(guide: Guide, urls: Record<string, string>): void {
  settings.value = null; settingsSaved.value = '';
  selected.value = guide; creating.value = false; settingsMode.value = false; slug.value = guide.slug;
  Object.assign(draft, JSON.parse(JSON.stringify(guide.draft))); images.value = urls; saved.value = serialize();
}
async function openGuide(row: GuideRow, force = false): Promise<void> {
  if (!force && !canLeave()) return;
  const request = ++selectionRequest; loading.value = true; error.value = ''; notice.value = ''; preview.value = false;
  try {
    const data = await callOps<{ guide: Guide; imageUrls: Record<string, string> }>('guides.detail', { guideId: row._id });
    if (!alive || request !== selectionRequest) return;
    fill(data.guide, data.imageUrls);
  } catch (err) { if (alive && request === selectionRequest) error.value = getErrorMessage(err, '读取指南失败，可再次点击重试'); }
  finally { if (request === selectionRequest) loading.value = false; }
}
function createGuide(): void {
  if (!canLeave()) return;
  settings.value = null; settingsSaved.value = '';
  selected.value = null; settingsMode.value = false; creating.value = true; slug.value = ''; images.value = {}; preview.value = false; error.value = ''; notice.value = '';
  Object.assign(draft, { title: '', summary: '', sortOrder: rows.value.length, related: [], body: { type: 'doc', content: [{ type: 'paragraph' }] } }); saved.value = serialize();
}
async function openSettings(): Promise<void> {
  if (!canLeave()) return;
  loading.value = true; error.value = ''; preview.value = false;
  try {
    const data = await callOps<Settings>('guides.settings.get');
    if (!alive) return;
    settings.value = data; Object.assign(settingsDraft, data.draft); settingsSaved.value = JSON.stringify(settingsDraft);
    selected.value = null; creating.value = false; settingsMode.value = true; saved.value = '';
  } catch (err) { error.value = getErrorMessage(err, '读取列表文案失败'); } finally { loading.value = false; }
}
async function mutate<T>(action: string, payload: Record<string, unknown>): Promise<T> {
  const key = action + JSON.stringify(payload); const requestId = pendingIds.get(key) || crypto.randomUUID(); pendingIds.set(key, requestId);
  const result = await callOps<T>(action, { ...payload, requestId }); pendingIds.delete(key); return result;
}
async function save(): Promise<void> {
  if (locked.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  try {
    const result = await mutate<{ guideId: string }>(creating.value ? 'guides.create' : 'guides.updateDraft', { ...(creating.value ? { slug: slug.value } : { guideId: selected.value?._id, revision: selected.value?.revision }), draft: JSON.parse(JSON.stringify(draft)) });
    const data = await callOps<{ guide: Guide; imageUrls: Record<string, string> }>('guides.detail', { guideId: result.guideId });
    if (!alive) return;
    fill(data.guide, data.imageUrls); await loadAll(); notice.value = '草稿已保存，发布后才会向用户展示。';
  } catch (err) { error.value = getErrorMessage(err, '保存失败，请重试'); } finally { busy.value = false; }
}
async function change(action: 'publish' | 'unpublish' | 'delete' | 'restore'): Promise<void> {
  if (locked.value || !selected.value) return;
  if (articleDirty.value) { error.value = '请先保存或放弃当前修改，再执行此操作。'; return; }
  if (action !== 'publish' && !window.confirm({ unpublish: '确认下架？小程序将不再展示这篇指南。', delete: '确认移入回收站？该文章将立即停止公开展示。', restore: '确认恢复为未发布草稿？' }[action])) return;
  busy.value = true; error.value = ''; notice.value = '';
  try {
    await mutate('guides.' + action, { guideId: selected.value._id, revision: selected.value.revision });
    const data = await callOps<{ guide: Guide; imageUrls: Record<string, string> }>('guides.detail', { guideId: selected.value._id });
    if (!alive) return;
    fill(data.guide, data.imageUrls); preview.value = false; await loadAll(); notice.value = { publish: '指南已发布，小程序下次进入页面时读取新内容。', unpublish: '指南已下架。', delete: '已移入回收站。', restore: '已恢复为未发布草稿。' }[action];
  } catch (err) { error.value = getErrorMessage(err, '操作失败，请重试'); } finally { busy.value = false; }
}
async function saveSettings(publish: boolean): Promise<void> {
  if (locked.value || !settings.value) return;
  if (publish && settingsDirty.value) { error.value = '请先保存列表文案草稿'; return; }
  if (publish && !window.confirm('确认发布当前列表标题和说明？小程序下次进入列表时生效。')) return;
  busy.value = true; error.value = ''; notice.value = '';
  try {
    await mutate('guides.settings.' + (publish ? 'publish' : 'updateDraft'), { revision: settings.value.revision, ...(publish ? {} : { draft: { ...settingsDraft } }) });
    const data = await callOps<Settings>('guides.settings.get');
    if (!alive) return;
    settings.value = data; Object.assign(settingsDraft, data.draft); settingsSaved.value = JSON.stringify(settingsDraft); notice.value = publish ? '列表文案已发布。' : '列表文案草稿已保存。';
  } catch (err) { error.value = getErrorMessage(err, '文案保存失败'); } finally { busy.value = false; }
}
function imageUploaded(value: { assetId: string; url: string }): void { images.value = { ...images.value, [value.assetId]: value.url }; }
onMounted(() => { window.addEventListener('beforeunload', beforeUnload); refresh(); });
onBeforeUnmount(() => { alive = false; selectionRequest++; window.removeEventListener('beforeunload', beforeUnload); });
</script>

<template>
  <section class="guide-manager">
    <header class="manager-heading"><div><p class="eyebrow">公开内容</p><h2>修谱指南</h2><p>先保存草稿，再预览发布。后台新增或更新后，新版小程序动态读取。</p></div><div class="actions"><button :disabled="locked" @click="openSettings">列表页文案</button><button :disabled="locked" class="primary" @click="createGuide">新增指南</button><button :disabled="locked" @click="refresh">刷新列表</button></div></header>
    <p v-if="error" class="message error" role="alert">{{ error }}</p><p v-if="notice" class="message success" role="status">{{ notice }}</p>
    <div class="manager-layout">
      <aside class="guide-list"><label>搜索标题<input v-model="keyword" placeholder="输入标题关键词" /></label><label>状态<select v-model="status"><option value="active">全部在用指南</option><option value="published">已发布</option><option value="draft">草稿</option><option value="unpublished">已下架</option><option value="deleted">回收站</option><option value="">全部（含回收站）</option></select></label><p class="muted">按排序值从小到大排列 · {{ visibleRows.length }} 篇</p><p v-if="loading">正在读取…</p><button v-for="row in visibleRows" :key="row._id" :disabled="locked" :class="{ selected: selected?._id === row._id }" @click="openGuide(row)"><strong>{{ row.title }}</strong><span>{{ statusName(row.status) }} · 排序 {{ row.sortOrder }}</span><small>{{ row.slug }}</small></button><p v-if="!loading && !visibleRows.length" class="muted">没有匹配的指南</p></aside>
      <div class="editor-panel">
        <template v-if="settingsMode">
          <h3>列表页标题与说明</h3><p class="muted">单独保存和发布，不影响文章内容。</p>
          <label>标题<input v-model="settingsDraft.title" maxlength="100" :disabled="locked" /></label><label>说明<textarea v-model="settingsDraft.summary" maxlength="500" :disabled="locked" /></label>
          <div class="actions"><button :disabled="locked" @click="saveSettings(false)">保存草稿</button><button class="primary" :disabled="locked || settingsDirty" @click="saveSettings(true)">发布列表文案</button></div>
          <article class="settings-preview"><p class="eyebrow">草稿预览</p><h2>{{ settingsDraft.title }}</h2><p>{{ settingsDraft.summary }}</p></article>
          <div v-if="settings" class="published-copy"><h4>当前已发布</h4><strong>{{ settings.published.title }}</strong><p>{{ settings.published.summary }}</p></div>
        </template>
        <template v-else-if="selected || creating">
          <div class="actions editor-actions"><strong>{{ creating ? '新增指南' : statusName(selected!.status) }}{{ articleDirty ? ' · 有未保存修改' : '' }}</strong><button :disabled="locked || selected?.status === 'deleted'" @click="save">{{ busy ? '处理中…' : '保存草稿' }}</button><button :disabled="locked || selected?.status === 'deleted'" @click="preview = true">手机预览 / 发布</button><button v-if="selected?.status === 'published'" :disabled="locked || articleDirty" @click="change('unpublish')">下架</button><button v-if="selected && selected.status !== 'deleted'" class="danger" :disabled="locked || articleDirty" @click="change('delete')">删除</button><button v-if="selected?.status === 'deleted'" :disabled="locked" @click="change('restore')">恢复为草稿</button><button v-if="selected" :disabled="locked" @click="openGuide(selected)">重新读取 / 放弃修改</button></div>
          <fieldset :disabled="locked || selected?.status === 'deleted'">
            <div class="field-grid"><label>标题<input v-model="draft.title" maxlength="100" /></label><label>文章标识<input v-model="slug" maxlength="80" :disabled="!creating" placeholder="如 family-stories" /><small>小写字母、数字和连字符，创建后固定。</small></label><label class="wide">摘要<textarea v-model="draft.summary" maxlength="500" /></label><label>展示顺序<input v-model.number="draft.sortOrder" type="number" min="0" max="999999" /><small>数值越小越靠前，发布后生效。</small></label><label>关联阅读（最多8篇）<select v-model="draft.related" multiple size="5"><option v-for="row in relatedChoices" :key="row.slug" :value="row.slug">{{ row.title }} · {{ statusName(row.status) }}</option></select><small>使用 Ctrl / Command 多选。未发布的关联指南不会公开展示。</small></label></div>
            <h3>正文</h3><GuideEditor :key="(selected?._id || 'new') + '-' + (selected?.revision || 0)" v-model="draft.body" :guide-id="selected?._id || ''" :image-urls="images" :disabled="locked || selected?.status === 'deleted'" @busy="imageBusy = $event" @uploaded="imageUploaded" />
          </fieldset>
        </template>
        <div v-else class="empty-state"><h3>选择一篇指南开始编辑</h3><p>也可以新增指南，或配置列表页顶部文案。</p></div>
      </div>
    </div>
    <div v-if="preview" class="preview-mask" @click.self="preview = false"><section class="preview-dialog"><div class="actions"><h3>手机宽度预览</h3><button :disabled="busy" @click="preview = false">关闭</button></div><p class="muted">预览当前编辑内容；{{ articleDirty || creating ? '请先关闭预览并保存草稿，再发布。' : '确认内容后发布，所有公开字段一并生效。' }}</p><GuidePreview :title="draft.title" :summary="draft.summary" :body="draft.body" :image-urls="images" /><button class="primary" :disabled="locked || articleDirty || creating || selected?.status === 'deleted'" @click="change('publish')">{{ busy ? '正在发布…' : '确认发布指南' }}</button><p v-if="error" class="message error">{{ error }}</p></section></div>
  </section>
</template>

<style scoped>
.guide-manager button{min-height:38px;padding:8px 12px;border:1px solid #cddbd1;border-radius:8px;background:#fff;color:#304c3d;cursor:pointer}.guide-manager button.primary{background:#245c4a;color:#fff;border-color:#245c4a}.guide-manager button:disabled{opacity:.5;cursor:default}.guide-manager .danger{color:#a13535}.manager-heading,.actions{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}.manager-heading{margin-bottom:20px}.manager-heading h2{font-size:30px;margin:4px 0}.manager-heading p{color:#65706a}.manager-layout{display:grid;grid-template-columns:270px minmax(0,1fr);border:1px solid #dce5de;border-radius:16px;overflow:hidden;background:#fff}.guide-list{padding:16px;background:#f5f8f3;border-right:1px solid #dce5de;max-height:1000px;overflow:auto}.guide-list>button{display:grid;gap:6px;width:100%;text-align:left;padding:13px;margin-top:10px;background:#fff;border:1px solid #dce5de;border-radius:9px}.guide-list .selected{outline:2px solid #245c4a}.guide-list span,.guide-list small,.muted,small{color:#65706a;font-size:12px;overflow-wrap:anywhere}.editor-panel{padding:24px;min-width:0}label{display:grid;gap:6px;font-size:13px;margin-bottom:14px}input,textarea,select{width:100%;min-width:0}textarea{min-height:80px}.field-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.wide{grid-column:1/-1}.editor-actions{position:sticky;top:0;padding:0 0 16px;background:#fff;z-index:2;justify-content:flex-start}fieldset{border:0;padding:0;margin:0;min-width:0}.danger{color:#a13535}.message{padding:12px 16px;border-radius:10px}.error{color:#9e3030;background:#fff0ef}.success{color:#245c4a;background:#edf7ef}.empty-state{padding:80px 10px;text-align:center;color:#65706a}.settings-preview,.published-copy{margin-top:24px;padding:20px;background:#f7faf5;border-radius:12px;overflow-wrap:anywhere}.preview-mask{position:fixed;inset:0;z-index:40;background:#152c2480;display:grid;place-items:center}.preview-dialog{background:#fff;padding:24px;border-radius:18px;width:min(650px,calc(100vw - 32px));max-height:90vh;overflow:auto}@media(max-width:1000px){.manager-layout{grid-template-columns:1fr}.guide-list{max-height:350px;border-right:0;border-bottom:1px solid #dce5de}.field-grid{grid-template-columns:1fr}.editor-panel{padding:16px}}
</style>
