<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import * as XLSX from 'xlsx';
import { callOps, getErrorMessage } from '../cloudbase';
import ExampleGraphPreview from './ExampleGraphPreview.vue';

type Row = Record<string, any>;
const props = defineProps<{ isSuperAdmin: boolean }>();
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const notice = ref('');
const rows = ref<Row[]>([]);
const selected = ref<Row | null>(null);
const versions = ref<Row[]>([]);
const failedSelection = ref<Row | null>(null);
const search = ref('');
const status = ref('all');
const personSearch = ref('');
const selectedPersonId = ref('');
const selectedRelationId = ref('');
const dirty = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const pendingImport = ref<{ content: Row; meta: Row; errors: string[] } | null>(null);
const relationForm = reactive({ fromPersonId: '', toPersonId: '', type: 'parent_child' });
const draft = reactive<any>({
  _id: '', title: '', slug: '', description: '', tagsText: '', sortOrder: 0, shareTitle: '', shareDescription: '',
  content: { family: { name: '', description: '' }, persons: [] as Row[], relations: [] as Row[] }
});

let localSequence = 0;
function localId(kind: string): string { localSequence += 1; return `local-${kind}-${Date.now().toString(36)}-${localSequence}`; }
function blankContent(title = ''): Row {
  const father = localId('person'); const mother = localId('person'); const child = localId('person');
  return {
    family: { name: title, description: '' },
    persons: [
      { _id: father, name: '张建国', gender: 'male', lifeStatus: 'living', birthDate: '', deathDate: '', birthPlace: '', bio: '' },
      { _id: mother, name: '李秀兰', gender: 'female', lifeStatus: 'living', birthDate: '', deathDate: '', birthPlace: '', bio: '' },
      { _id: child, name: '张小雨', gender: 'female', lifeStatus: 'living', birthDate: '', deathDate: '', birthPlace: '', bio: '' }
    ],
    relations: [
      { _id: localId('relation'), type: 'spouse', fromPersonId: father, toPersonId: mother },
      { _id: localId('relation'), type: 'parent_child', fromPersonId: father, toPersonId: child },
      { _id: localId('relation'), type: 'parent_child', fromPersonId: mother, toPersonId: child }
    ]
  };
}

const filteredRows = computed(() => rows.value.filter((item) => {
  const matchesStatus = status.value === 'all' || item.status === status.value;
  return matchesStatus && `${item.title} ${item.slug}`.toLowerCase().includes(search.value.trim().toLowerCase());
}));
const visiblePersons = computed(() => draft.content.persons.filter((person: Row) => {
  const query = personSearch.value.trim();
  return !query || String(person.name || '').includes(query);
}));
const graphErrors = computed(() => validateContent(draft.content));

watch(draft, () => { if (draft._id) dirty.value = true; }, { deep: true });

function resetDraft(source: Row = {}): void {
  const content = structuredClone(source.draftContent || blankContent(source.title || ''));
  Object.assign(draft, {
    _id: source._id || '', title: source.title || '', slug: source.slug || '', description: source.description || '',
    tagsText: Array.isArray(source.tags) ? source.tags.join('、') : '', sortOrder: source.sortOrder || 0,
    shareTitle: source.shareTitle || '', shareDescription: source.shareDescription || '', content
  });
  relationForm.fromPersonId = content.persons[0]?._id || '';
  relationForm.toPersonId = content.persons[1]?._id || '';
  dirty.value = false;
}

function personName(id: string): string { return draft.content.persons.find((person: Row) => person._id === id)?.name?.trim() || ''; }
function nameBasedContent(content = draft.content): Row {
  return {
    family: { name: draft.title.trim(), description: draft.description.trim() },
    persons: content.persons.map((person: Row) => ({
      _id: person._id || '', name: String(person.name || '').trim(), gender: person.gender || 'unknown', lifeStatus: person.lifeStatus || 'unknown',
      birthDate: person.birthDate || '', deathDate: person.deathDate || '', birthPlace: person.birthPlace || '', bio: person.bio || ''
    })),
    relations: content.relations.map((relation: Row) => ({
      _id: relation._id || '', type: relation.type, fromPersonName: personName(relation.fromPersonId), toPersonName: personName(relation.toPersonId)
    }))
  };
}
function payload(): Row {
  return {
    templateId: draft._id, title: draft.title.trim(), slug: draft.slug.trim(), description: draft.description.trim(),
    tags: draft.tagsText.split(/[、,，\s]+/).filter(Boolean), sortOrder: Number(draft.sortOrder) || 0,
    shareTitle: draft.shareTitle.trim(), shareDescription: draft.shareDescription.trim(), draftContent: nameBasedContent()
  };
}

async function loadList(): Promise<void> {
  loading.value = true;
  try { rows.value = (await callOps<{ items: Row[] }>('examples.list', { pageSize: 50 })).items || []; }
  catch (err) { error.value = `示例列表加载失败：${getErrorMessage(err, '请重试')}`; }
  finally { loading.value = false; }
}
async function selectTemplate(row: Row, force = false): Promise<void> {
  if (!force && dirty.value && !window.confirm('当前草稿尚未保存，切换后将放弃本地修改。继续切换？')) return;
  error.value = ''; failedSelection.value = null;
  try {
    const data = await callOps<{ template: Row; versions: Row[] }>('examples.detail', { templateId: row._id });
    selected.value = data.template; versions.value = data.versions || []; resetDraft(data.template);
  } catch (err) {
    failedSelection.value = row;
    error.value = `加载示例草稿失败：${getErrorMessage(err, '请重试')}`;
  }
}
async function retrySelected(): Promise<void> { if (failedSelection.value) await selectTemplate(failedSelection.value, true); }
async function createTemplate(): Promise<void> {
  saving.value = true;
  try {
    const title = '新的示例家谱';
    const result = await callOps<{ templateId: string }>('examples.create', {
      title, slug: `example-${Date.now().toString(36)}`, draftContent: blankContent(title), tags: [], sortOrder: rows.value.length
    });
    await loadList();
    const row = rows.value.find((item) => item._id === result.templateId);
    if (row) await selectTemplate(row, true);
    notice.value = '草稿已创建。人物和关系均以姓名维护，内部标识由服务端生成。';
  } catch (err) { error.value = `创建示例失败：${getErrorMessage(err, '请重试')}`; }
  finally { saving.value = false; }
}
async function saveDraft(): Promise<void> {
  if (!draft._id || saving.value) return;
  const errors = validateContent(draft.content);
  if (errors.length) { error.value = `保存草稿前请修正：${errors[0]}`; return; }
  saving.value = true; error.value = '';
  try {
    const result = await callOps<{ templateId: string; draftContent: Row }>('examples.updateDraft', payload());
    if (result.draftContent) {
      draft.content = result.draftContent;
      relationForm.fromPersonId = draft.content.persons[0]?._id || '';
      relationForm.toPersonId = draft.content.persons[1]?._id || '';
    }
    dirty.value = false; notice.value = '草稿已保存，人物与关系的内部标识已由服务端同步。'; await loadList();
  } catch (err) { error.value = `保存草稿失败：${getErrorMessage(err, '请重试')}`; }
  finally { saving.value = false; }
}
async function runAction(action: string, extra: Row = {}): Promise<void> {
  if (!draft._id || !props.isSuperAdmin) return;
  saving.value = true;
  try {
    await callOps(action, { templateId: draft._id, ...extra });
    notice.value = action === 'examples.publish' ? '示例已发布。' : action === 'examples.unpublish' ? '示例已下架。' : action === 'examples.archive' ? '示例已归档。' : '示例已回滚。';
    await loadList(); const row = rows.value.find((item) => item._id === draft._id); if (row) await selectTemplate(row, true);
  } catch (err) { error.value = `示例操作失败：${getErrorMessage(err, '请重试')}`; }
  finally { saving.value = false; }
}

function addPerson(): void { draft.content.persons.push({ _id: localId('person'), name: '', gender: 'unknown', lifeStatus: 'unknown', birthDate: '', deathDate: '', birthPlace: '', bio: '' }); }
function removePerson(id: string): void {
  const count = draft.content.relations.filter((relation: Row) => relation.fromPersonId === id || relation.toPersonId === id).length;
  if (!window.confirm(`删除人物将同时移除 ${count} 条关系，继续吗？`)) return;
  draft.content.persons = draft.content.persons.filter((person: Row) => person._id !== id);
  draft.content.relations = draft.content.relations.filter((relation: Row) => relation.fromPersonId !== id && relation.toPersonId !== id);
}
function addRelation(): void {
  if (relationForm.fromPersonId && relationForm.toPersonId && relationForm.fromPersonId !== relationForm.toPersonId) {
    draft.content.relations.push({ _id: localId('relation'), type: relationForm.type, fromPersonId: relationForm.fromPersonId, toPersonId: relationForm.toPersonId });
  }
}
function removeRelation(id: string): void { draft.content.relations = draft.content.relations.filter((relation: Row) => relation._id !== id); }
function scrollTo(kind: string, id: string): void {
  if (kind === 'person') selectedPersonId.value = id; else selectedRelationId.value = id;
  document.getElementById(`${kind}-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function validateContent(content: Row): string[] {
  const errors: string[] = []; const names = new Set<string>(); const ids = new Set<string>();
  const nameById: Record<string, string> = {};
  content.persons.forEach((person: Row, index: number) => {
    const name = String(person.name || '').trim();
    if (!name) errors.push(`人物第 ${index + 1} 行缺少姓名`);
    else if (names.has(name)) errors.push(`人物姓名重复：${name}`);
    names.add(name); ids.add(person._id); nameById[person._id] = name;
  });
  if (content.persons.length < 3) errors.push('示例至少需要 3 位人物');
  const relationKeys = new Set<string>(); const children: Record<string, string[]> = {};
  content.relations.forEach((relation: Row, index: number) => {
    const fromName = nameById[relation.fromPersonId] || ''; const toName = nameById[relation.toPersonId] || '';
    if (!['parent_child', 'spouse'].includes(relation.type)) errors.push(`关系第 ${index + 1} 行类型无效`);
    if (!ids.has(relation.fromPersonId) || !ids.has(relation.toPersonId) || !fromName || !toName || relation.fromPersonId === relation.toPersonId) errors.push(`关系第 ${index + 1} 行人物姓名无效`);
    const pair = relation.type === 'spouse' && fromName > toName ? [toName, fromName] : [fromName, toName];
    const key = `${relation.type}:${pair.join(':')}`;
    if (relationKeys.has(key)) errors.push(`关系重复：${key}`); relationKeys.add(key);
    if (relation.type === 'parent_child') (children[relation.fromPersonId] ||= []).push(relation.toPersonId);
  });
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true; if (visited.has(id)) return false;
    visiting.add(id); const cyclic = (children[id] || []).some(visit); visiting.delete(id); visited.add(id); return cyclic;
  };
  if (Array.from(ids).some(visit)) errors.push('父母子女关系存在祖先循环');
  if (content.relations.length < 2) errors.push('示例至少需要 2 条关系');
  return errors;
}

function metadataRows(source: Row = draft): Row[] {
  return [
    { 字段: '名称', 值: source.title || '' }, { 字段: '简介', 值: source.description || '' }, { 字段: '标签', 值: source.tagsText || '' },
    { 字段: '排序', 值: source.sortOrder || 0 }, { 字段: '分享标题', 值: source.shareTitle || '' }, { 字段: '分享说明', 值: source.shareDescription || '' },
    { 字段: '稳定链接标识（仅供查看，不可导入修改）', 值: source.slug || '' }
  ];
}
function sheets(content = draft.content, metadataSource: Row = draft): Row {
  const nameFor = (id: string) => content.persons.find((person: Row) => person._id === id)?.name?.trim() || '';
  return {
    家谱资料: metadataRows(metadataSource),
    人物: content.persons.map((person: Row) => ({ 姓名: person.name, 性别: person.gender, 在世状态: person.lifeStatus, 出生日期: person.birthDate, 去世日期: person.deathDate, 籍贯: person.birthPlace, 人物简介: person.bio })),
    关系: content.relations.map((relation: Row) => ({ 起始人物姓名: nameFor(relation.fromPersonId), 关系类型: relation.type, 结束人物姓名: nameFor(relation.toPersonId) })),
    填写说明: [{ 说明: '人物姓名为唯一管理项，不填写任何 ID；关系中的两端姓名必须与人物表完全一致。性别：male / female / unknown；在世状态：living / deceased / unknown；关系类型：parent_child / spouse。导入将整体替换草稿。' }]
  };
}
function workbook(content = draft.content, metadataSource: Row = draft): XLSX.WorkBook {
  const book = XLSX.utils.book_new();
  Object.entries(sheets(content, metadataSource)).forEach(([name, data]) => XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(data as Row[]), name));
  return book;
}
function exportExcel(): void { XLSX.writeFile(workbook(), `${draft.slug || 'example'}-示例家谱.xlsx`, { compression: true }); }
function exportCsv(): void {
  Object.entries(sheets()).filter(([name]) => name !== '填写说明').forEach(([name, values]) => {
    const blob = new Blob([XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(values as Row[]))], { type: 'text/csv;charset=utf-8' });
    const anchor = document.createElement('a'); anchor.href = URL.createObjectURL(blob); anchor.download = `${draft.slug || 'example'}-${name}.csv`; anchor.click(); URL.revokeObjectURL(anchor.href);
  });
}
function downloadTemplate(): void {
  const template = blankContent('示例家谱模板');
  XLSX.writeFile(workbook(template, { title: '示例家谱模板', description: '', tagsText: '', sortOrder: 0, shareTitle: '', shareDescription: '', slug: '' }), '示例家谱导入模板.xlsx', { compression: true });
}
function rowsFromSheet(sheet: XLSX.WorkSheet | undefined): Row[] { return sheet ? XLSX.utils.sheet_to_json(sheet, { defval: '' }) as Row[] : []; }
function openImport(): void { pendingImport.value = null; fileInput.value?.click(); }
function normalizeType(value: any): string { return value === 'spouse' || value === '伴侣' ? 'spouse' : value === 'parent_child' || value === '父母子女' ? 'parent_child' : String(value || ''); }
async function importFiles(event: Event): Promise<void> {
  const files = Array.from((event.target as HTMLInputElement).files || []); if (!files.length) return;
  const collected: Record<string, Row[]> = {};
  for (const file of files) {
    const book = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    book.SheetNames.forEach((name) => { collected[name] = rowsFromSheet(book.Sheets[name]); });
    if (book.SheetNames.length === 1) {
      const lower = file.name.toLowerCase();
      collected[lower.includes('person') || file.name.includes('人物') ? '人物' : lower.includes('relation') || file.name.includes('关系') ? '关系' : '家谱资料'] = rowsFromSheet(book.Sheets[book.SheetNames[0]]);
    }
  }
  const meta = Object.fromEntries((collected.家谱资料 || []).map((row) => [row.字段, row.值]));
  const people = (collected.人物 || []).map((person) => ({
    _id: localId('import-person'), name: String(person.姓名 || '').trim(), gender: person.性别 || 'unknown', lifeStatus: person.在世状态 || 'unknown',
    birthDate: String(person.出生日期 || ''), deathDate: String(person.去世日期 || ''), birthPlace: String(person.籍贯 || ''), bio: String(person.人物简介 || '')
  }));
  const peopleByName = new Map<string, Row>(); people.forEach((person) => { if (!peopleByName.has(person.name)) peopleByName.set(person.name, person); });
  const relations = (collected.关系 || []).map((relation) => {
    const fromName = String(relation.起始人物姓名 || '').trim(); const toName = String(relation.结束人物姓名 || '').trim();
    return { _id: localId('import-relation'), type: normalizeType(relation.关系类型), fromPersonId: peopleByName.get(fromName)?._id || '', toPersonId: peopleByName.get(toName)?._id || '', fromName, toName };
  });
  const content = { family: { name: String(meta.名称 || draft.title), description: String(meta.简介 || draft.description) }, persons: people, relations };
  const errors = validateContent(content);
  relations.forEach((relation, index) => { if (!relation.fromPersonId || !relation.toPersonId) errors.push(`关系第 ${index + 1} 行引用的人名未在人物表找到`); });
  pendingImport.value = { content, meta, errors: Array.from(new Set(errors)) };
  (event.target as HTMLInputElement).value = '';
}
async function confirmImport(): Promise<void> {
  if (!pendingImport.value || pendingImport.value.errors.length) return;
  const item = pendingImport.value;
  Object.assign(draft, {
    title: String(item.meta.名称 || draft.title), description: String(item.meta.简介 || ''), tagsText: String(item.meta.标签 || ''), sortOrder: Number(item.meta.排序) || 0,
    shareTitle: String(item.meta.分享标题 || ''), shareDescription: String(item.meta.分享说明 || ''), content: item.content
  });
  pendingImport.value = null; await saveDraft();
}

onMounted(loadList);
</script>

<template>
  <section class="example-manager">
    <header class="manager-header"><div><p class="eyebrow">OFFICIAL READ-ONLY CONTENT</p><h2>多示例家谱库</h2><p>以姓名维护人物和关系；内部标识仅由服务端生成。</p></div><button class="primary" :disabled="saving" @click="createTemplate">新建示例</button></header>
    <p v-if="error" class="message error">{{ error }} <button v-if="failedSelection" class="retry" @click="retrySelected">重试加载</button><small v-if="failedSelection">错误详情包含请求 ID，可用于日志检索。</small></p>
    <p v-if="notice" class="message success">{{ notice }}</p>
    <div class="manager-layout">
      <aside class="template-list"><input v-model="search" placeholder="搜索名称或 slug"/><select v-model="status"><option value="all">全部状态</option><option value="draft">草稿</option><option value="published">已发布</option><option value="archived">已归档</option></select><button v-for="item in filteredRows" :key="item._id" :class="{ active:selected?._id===item._id }" @click="selectTemplate(item)"><strong>{{ item.title }}</strong><span>{{ item.slug }}</span><small>{{ item.personCount }} 人 · {{ item.relationCount }} 条关系 · {{ item.updatedAt ? new Date(item.updatedAt).toLocaleDateString() : '未更新' }}</small><em :class="item.status">{{ item.status === 'published' ? `已发布 v${item.publishedVersion}` : item.status === 'archived' ? '已归档' : '草稿' }}</em></button><div v-if="loading" class="state">正在读取示例…</div></aside>
      <section v-if="selected" class="editor">
        <div class="editor-actions"><button class="secondary" :disabled="saving" @click="saveDraft">{{ dirty ? '保存草稿 *' : '草稿已保存' }}</button><button class="secondary" @click="downloadTemplate">下载模板</button><button class="secondary" @click="exportExcel">导出 Excel</button><button class="secondary" @click="exportCsv">导出 CSV</button><button class="secondary" @click="openImport">导入表格</button><input ref="fileInput" class="hidden" type="file" accept=".xlsx,.xls,.csv" multiple @change="importFiles"/><template v-if="isSuperAdmin"><button v-if="selected.status !== 'archived'" class="primary publish-button" :disabled="saving" @click="runAction('examples.publish')">{{ selected.status === 'published' ? '发布更新' : '发布' }}</button><button v-if="selected.status === 'published'" class="secondary" :disabled="saving" @click="runAction('examples.unpublish')">下架</button><button v-if="selected.status !== 'published'" class="danger-button" :disabled="saving" @click="runAction('examples.archive')">归档</button></template></div>
        <section class="editor-section"><h3>家谱资料</h3><div class="field-grid"><label>示例名称<input v-model="draft.title"/></label><label>稳定链接标识<input v-model="draft.slug" disabled/></label><label>标签<input v-model="draft.tagsText" placeholder="用逗号分隔"/></label><label>排序<input v-model.number="draft.sortOrder" type="number" min="0"/></label><label class="wide">简介<textarea v-model="draft.description"/></label><label>微信分享标题<input v-model="draft.shareTitle"/></label><label>微信分享说明<input v-model="draft.shareDescription"/></label></div></section>
        <section class="editor-section"><div class="section-head"><div><h3>人物表（{{ draft.content.persons.length }}）</h3><p class="muted">姓名必须唯一，用于维护所有关系。</p></div><div><input v-model="personSearch" placeholder="筛选姓名"/><button class="secondary compact" @click="addPerson">添加人物</button></div></div><div class="table-wrap"><table><thead><tr><th>姓名</th><th>性别</th><th>状态</th><th>出生</th><th>去世</th><th>籍贯</th><th>简介</th><th></th></tr></thead><tbody><tr v-for="person in visiblePersons" :id="`person-${person._id}`" :key="person._id" :class="{ selected: selectedPersonId===person._id }" @click="selectedPersonId=person._id"><td><input v-model="person.name" placeholder="唯一姓名"/></td><td><select v-model="person.gender"><option value="unknown">未填写</option><option value="male">男</option><option value="female">女</option></select></td><td><select v-model="person.lifeStatus"><option value="unknown">未填写</option><option value="living">健在</option><option value="deceased">已故</option></select></td><td><input v-model="person.birthDate" placeholder="YYYY-MM-DD"/></td><td><input v-model="person.deathDate" placeholder="YYYY-MM-DD"/></td><td><input v-model="person.birthPlace"/></td><td><input v-model="person.bio"/></td><td><button class="text-danger" @click.stop="removePerson(person._id)">删除</button></td></tr></tbody></table></div></section>
        <section class="editor-section"><div class="section-head"><div><h3>关系表（{{ draft.content.relations.length }}）</h3><p class="muted">用人物姓名建立关系，不需要填写任何 ID。</p></div><div class="relation-create"><select v-model="relationForm.fromPersonId"><option v-for="person in draft.content.persons" :key="person._id" :value="person._id">{{ person.name || '未命名人物' }}</option></select><select v-model="relationForm.type"><option value="parent_child">父母 → 子女</option><option value="spouse">伴侣</option></select><select v-model="relationForm.toPersonId"><option v-for="person in draft.content.persons" :key="person._id" :value="person._id">{{ person.name || '未命名人物' }}</option></select><button class="secondary compact" @click="addRelation">添加关系</button></div></div><div class="table-wrap"><table><thead><tr><th>起始人物</th><th>关系类型</th><th>结束人物</th><th></th></tr></thead><tbody><tr v-for="relation in draft.content.relations" :id="`relation-${relation._id}`" :key="relation._id" :class="{ selected:selectedRelationId===relation._id }" @click="selectedRelationId=relation._id"><td><select v-model="relation.fromPersonId"><option v-for="person in draft.content.persons" :key="person._id" :value="person._id">{{ person.name || '未命名人物' }}</option></select></td><td><select v-model="relation.type"><option value="parent_child">父母 → 子女</option><option value="spouse">伴侣</option></select></td><td><select v-model="relation.toPersonId"><option v-for="person in draft.content.persons" :key="person._id" :value="person._id">{{ person.name || '未命名人物' }}</option></select></td><td><button class="text-danger" @click.stop="removeRelation(relation._id)">删除</button></td></tr></tbody></table></div></section>
        <section class="editor-section"><h3>关系图校对（图谱预览）</h3><p class="muted">拖动查看全谱；点击人物或关系线可定位到对应表格行。</p><ul v-if="graphErrors.length" class="graph-errors"><li v-for="item in graphErrors" :key="item">{{ item }}</li></ul><ExampleGraphPreview :persons="draft.content.persons" :relations="draft.content.relations" :selected-person-id="selectedPersonId" :selected-relation-id="selectedRelationId" @select-person="scrollTo('person',$event)" @select-relation="scrollTo('relation',$event)"/></section>
        <section v-if="versions.length" class="editor-section"><h3>发布版本</h3><div class="versions"><article v-for="version in versions" :key="version._id"><span>v{{ version.version }}</span><small>{{ version.publishedByName || '运营人员' }} · {{ new Date(version.publishedAt).toLocaleString('zh-CN') }}</small><button v-if="isSuperAdmin" class="secondary compact" @click="runAction('examples.rollback',{versionId:version._id})">回滚到此版本</button></article></div></section>
      </section>
      <section v-else class="editor empty"><h3>选择或新建一个示例</h3></section>
    </div>
    <div v-if="pendingImport" class="import-mask"><section class="import-dialog"><h3>导入预览</h3><p>将整体替换当前草稿：{{ pendingImport.content.persons.length }} 人、{{ pendingImport.content.relations.length }} 条关系。</p><ul v-if="pendingImport.errors.length"><li v-for="item in pendingImport.errors" :key="item">{{ item }}</li></ul><p v-else class="ok">姓名与关系基础校验通过；确认后由服务端生成隐藏 ID 并完成最终校验。</p><div><button class="secondary" @click="pendingImport=null">取消</button><button class="primary" :disabled="Boolean(pendingImport.errors.length)||saving" @click="confirmImport">确认覆盖并保存</button></div></section></div>
  </section>
</template>

<style scoped>
.example-manager{min-height:560px}.manager-header,.editor-actions,.section-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.manager-header{margin-bottom:20px}.manager-header h2{margin:0;font:650 30px/1.15 Georgia,"Noto Serif SC",serif}.manager-header p:not(.eyebrow),.muted{color:#65706a}.muted{margin:5px 0 0;font-size:12px}.message{padding:12px;border-radius:10px}.error{color:#9f3030;background:#fff0ee}.error small{margin-left:8px;color:#8a5b5b}.retry{margin-left:8px;color:inherit;background:transparent;border:0;text-decoration:underline}.success,.ok{color:#286147;background:#edf7f1}.manager-layout{display:grid;grid-template-columns:280px minmax(0,1fr);background:#fff;border:1px solid #dfe5e1;border-radius:18px}.template-list{min-height:650px;padding:12px;background:#f6f8f5;border-right:1px solid #e4e9e5}.template-list>input,.template-list>select{width:100%;margin-bottom:8px}.template-list button{width:100%;margin-bottom:8px;padding:12px;display:grid;gap:4px;background:#fff;border:1px solid #e0e6e2;border-radius:11px;text-align:left}.template-list button.active,.selected{outline:2px solid #245c4a;background:#edf7f1!important}.template-list span,.template-list small{overflow:hidden;color:#718079;font-size:11px;text-overflow:ellipsis;white-space:nowrap}.template-list em{width:max-content;padding:3px 7px;color:#85601b;background:#fff1d8;border-radius:99px;font-size:10px;font-style:normal}.template-list em.published{color:#346352;background:#e7f0ec}.template-list em.archived{color:#6e7772;background:#edf0ee}.editor{min-width:0;padding:24px}.editor.empty{display:grid;place-content:center}.editor-actions{position:sticky;top:0;z-index:3;padding-bottom:16px;background:#fff;flex-wrap:wrap}.editor-section{margin-top:22px;padding-top:22px;border-top:1px solid #e8ece9}.editor-section h3{margin:0 0 8px}.field-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.field-grid label{display:grid;gap:6px;font-size:12px;font-weight:700}.wide{grid-column:1/-1}.field-grid textarea{min-height:64px}.table-wrap{overflow:auto;border:1px solid #e3e8e4;border-radius:10px}table{width:100%;border-collapse:collapse;font-size:12px}th,td{padding:8px;border-bottom:1px solid #edf0ee;white-space:nowrap;text-align:left}th{color:#65706a;background:#f7f9f7}td input,td select{min-width:86px;padding:5px}.relation-create{display:flex;gap:6px}.relation-create select{max-width:160px}.compact{min-height:32px;padding:0 10px}.text-danger{color:#a13333;background:transparent;border:0;font-weight:700}.graph-errors{padding:10px 28px;color:#9f3030;background:#fff5f3;border-radius:8px}.versions article{padding:10px;display:grid;grid-template-columns:55px 1fr auto;gap:8px;background:#f8faf7;border:1px solid #e3e8e4;border-radius:10px}.hidden{display:none}.import-mask{position:fixed;z-index:20;inset:0;display:grid;place-items:center;background:rgba(23,35,31,.42)}.import-dialog{width:min(520px,calc(100vw - 40px));padding:24px;background:#fff;border-radius:16px}.import-dialog ul{max-height:180px;overflow:auto;color:#9f3030}.import-dialog>div{display:flex;justify-content:flex-end;gap:10px}@media(max-width:900px){.manager-layout{grid-template-columns:1fr}.template-list{min-height:0;border-right:0;border-bottom:1px solid #e4e9e5}.field-grid{grid-template-columns:1fr}.relation-create{flex-wrap:wrap}}
</style>
