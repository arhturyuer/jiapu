<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import * as XLSX from 'xlsx';
import { callOps, getErrorMessage, getValidationIssues } from '../cloudbase';
// @ts-ignore Pure ESM validation is also exercised directly by the Node test suite.
import { groupValidationIssues, issuesForRow, validateExampleContent } from '../example-validation.js';
import ExampleGraphPreview from './ExampleGraphPreview.vue';

type Row = Record<string, any>;
type EditorTab = 'details' | 'persons' | 'relations' | 'preview' | 'display';
type DisplayPreference = { nameLayout: 'horizontal' | 'vertical'; showChildRankBadge: boolean; showGenderBadge: boolean; showGenderColors: boolean; autoCollapseEnabled: boolean };
const defaultDisplayPreference: DisplayPreference = { nameLayout: 'horizontal', showChildRankBadge: false, showGenderBadge: false, showGenderColors: true, autoCollapseEnabled: true };
const editorTabs: { key: EditorTab; label: string }[] = [
  { key: 'details', label: '家谱资料' }, { key: 'persons', label: '人物表' }, { key: 'relations', label: '关系表' },
  { key: 'preview', label: '预览图' }, { key: 'display', label: '默认展示' }
];
type ValidationIssue = {
  code: string;
  scope: 'person' | 'relation' | 'content';
  field: string;
  message: string;
  rowIndex?: number;
  sheetRow?: number;
  relatedRows?: number[];
};
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
const activeTab = ref<EditorTab>('details');
const dirty = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const serverValidationIssues = ref<ValidationIssue[]>([]);
const pendingImport = ref<{ content: Row; meta: Row; issues: ValidationIssue[]; canLoad: boolean } | null>(null);
const relationForm = reactive({ fromPersonId: '', toPersonId: '', type: 'parent_child' });
const draft = reactive<any>({
  _id: '', title: '', slug: '', description: '', tagsText: '', sortOrder: 0, shareTitle: '', shareDescription: '',
  displayPreference: { ...defaultDisplayPreference },
  content: { family: { name: '', description: '' }, persons: [] as Row[], relations: [] as Row[] }
});

let localSequence = 0;
let skipNextDirtyMark = false;
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
const visiblePersons = computed(() => draft.content.persons
  .map((person: Row, index: number) => ({ person, index }))
  .filter(({ person }: { person: Row }) => {
    const query = personSearch.value.trim();
    return !query || String(person.name || '').includes(query);
  }));
const relationRows = computed(() => draft.content.relations.map((relation: Row, index: number) => ({ relation, index })));
const validationIssues = computed<ValidationIssue[]>(() => validateExampleContent(draft.content));
const displayedIssues = computed<ValidationIssue[]>(() => {
  const seen = new Set<string>();
  return validationIssues.value.concat(serverValidationIssues.value).filter((item) => {
    const key = `${item.code}:${item.scope}:${item.rowIndex ?? ''}:${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
});
const groupedDraftIssues = computed(() => groupValidationIssues(displayedIssues.value));
const pendingImportGroups = computed(() => groupValidationIssues(pendingImport.value?.issues || []));

watch(draft, () => {
  if (skipNextDirtyMark) skipNextDirtyMark = false;
  else if (draft._id) dirty.value = true;
  serverValidationIssues.value = [];
}, { deep: true });

function resetDraft(source: Row = {}): void {
  const content = structuredClone(source.draftContent || blankContent(source.title || ''));
  skipNextDirtyMark = true;
  Object.assign(draft, {
    _id: source._id || '', title: source.title || '', slug: source.slug || '', description: source.description || '',
    tagsText: Array.isArray(source.tags) ? source.tags.join('、') : '', sortOrder: source.sortOrder || 0,
    shareTitle: source.shareTitle || '', shareDescription: source.shareDescription || '',
    displayPreference: { ...defaultDisplayPreference, ...(source.draftDisplayPreference || {}) }, content
  });
  relationForm.fromPersonId = content.persons[0]?._id || '';
  relationForm.toPersonId = content.persons[1]?._id || '';
  serverValidationIssues.value = [];
  dirty.value = false;
  activeTab.value = 'details';
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
    shareTitle: draft.shareTitle.trim(), shareDescription: draft.shareDescription.trim(), draftContent: nameBasedContent(),
    draftDisplayPreference: { ...draft.displayPreference }
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
      title, slug: `example-${Date.now().toString(36)}`, draftContent: blankContent(title),
      draftDisplayPreference: { ...defaultDisplayPreference }, tags: [], sortOrder: rows.value.length
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
  if (validationIssues.value.length) {
    error.value = `保存草稿前请修正全部 ${validationIssues.value.length} 项问题。`;
    focusIssue(validationIssues.value[0]);
    return;
  }
  saving.value = true; error.value = '';
  try {
    const result = await callOps<{ templateId: string; draftContent: Row; draftDisplayPreference: DisplayPreference }>('examples.updateDraft', payload());
    if (result.draftContent) {
      skipNextDirtyMark = true;
      draft.content = result.draftContent;
      relationForm.fromPersonId = draft.content.persons[0]?._id || '';
      relationForm.toPersonId = draft.content.persons[1]?._id || '';
    }
    dirty.value = false; notice.value = '草稿已保存，人物与关系的内部标识已由服务端同步。'; await loadList();
  } catch (err) {
    serverValidationIssues.value = getValidationIssues(err) as ValidationIssue[];
    if (serverValidationIssues.value.length) focusIssue(serverValidationIssues.value[0]);
    error.value = `保存草稿失败：${getErrorMessage(err, '请重试')}`;
  }
  finally { saving.value = false; }
}
async function runAction(action: string, extra: Row = {}): Promise<void> {
  if (!draft._id || !props.isSuperAdmin) return;
  if (action === 'examples.publish' && (dirty.value || validationIssues.value.length)) {
    error.value = validationIssues.value.length
      ? `发布前请修正全部 ${validationIssues.value.length} 项问题并保存草稿。`
      : '发布前请先保存当前草稿。';
    if (validationIssues.value.length) focusIssue(validationIssues.value[0]);
    return;
  }
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
  if (kind === 'person') {
    activeTab.value = 'persons';
    selectedPersonId.value = id;
    personSearch.value = '';
  } else {
    activeTab.value = 'relations';
    selectedRelationId.value = id;
  }
  void nextTick(() => document.getElementById(`${kind}-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
}
function rowIssues(scope: 'person' | 'relation', index: number): ValidationIssue[] {
  return issuesForRow(displayedIssues.value, scope, index);
}
function personExists(id: string): boolean {
  return draft.content.persons.some((person: Row) => person._id === id);
}
function validRelationType(type: string): boolean {
  return ['parent_child', 'spouse'].includes(type);
}
function focusIssue(item: ValidationIssue): void {
  if (item.scope === 'person' && item.rowIndex !== undefined) {
    const person = draft.content.persons[item.rowIndex];
    if (person) scrollTo('person', person._id);
    return;
  }
  if (item.scope === 'relation' && item.rowIndex !== undefined) {
    const relation = draft.content.relations[item.rowIndex];
    if (relation) scrollTo('relation', relation._id);
    return;
  }
  document.getElementById('example-validation-summary')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function issueKey(item: ValidationIssue, index: number): string {
  return `${item.code}-${item.scope}-${item.rowIndex ?? 'all'}-${index}`;
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
  const structuralIssues: ValidationIssue[] = [];
  if (!Object.prototype.hasOwnProperty.call(collected, '人物')) {
    structuralIssues.push({ code: 'EXAMPLE_IMPORT_PERSON_SHEET_REQUIRED', scope: 'content', field: 'persons', message: '导入文件缺少“人物”表，无法载入草稿' });
  }
  if (!Object.prototype.hasOwnProperty.call(collected, '关系')) {
    structuralIssues.push({ code: 'EXAMPLE_IMPORT_RELATION_SHEET_REQUIRED', scope: 'content', field: 'relations', message: '导入文件缺少“关系”表，无法载入草稿' });
  }
  const meta = Object.fromEntries((collected.家谱资料 || []).map((row) => [row.字段, row.值]));
  const people = (collected.人物 || []).map((person) => ({
    _id: localId('import-person'), name: String(person.姓名 || '').trim(), gender: person.性别 || 'unknown', lifeStatus: person.在世状态 || 'unknown',
    birthDate: String(person.出生日期 || ''), deathDate: String(person.去世日期 || ''), birthPlace: String(person.籍贯 || ''), bio: String(person.人物简介 || '')
  }));
  const peopleByName = new Map<string, Row[]>();
  people.forEach((person) => {
    const matches = peopleByName.get(person.name) || [];
    matches.push(person);
    peopleByName.set(person.name, matches);
  });
  const relations = (collected.关系 || []).map((relation) => {
    const fromName = String(relation.起始人物姓名 || '').trim(); const toName = String(relation.结束人物姓名 || '').trim();
    const fromMatches = peopleByName.get(fromName) || []; const toMatches = peopleByName.get(toName) || [];
    return {
      _id: localId('import-relation'), type: normalizeType(relation.关系类型),
      fromPersonId: fromMatches.length === 1 ? fromMatches[0]._id : '',
      toPersonId: toMatches.length === 1 ? toMatches[0]._id : '',
      fromName, toName
    };
  });
  const content = { family: { name: String(meta.名称 || draft.title), description: String(meta.简介 || draft.description) }, persons: people, relations };
  const issues = structuralIssues.concat(validateExampleContent(content) as ValidationIssue[]);
  pendingImport.value = { content, meta, issues, canLoad: structuralIssues.length === 0 };
  (event.target as HTMLInputElement).value = '';
}
function applyPendingImport(): boolean {
  if (!pendingImport.value || !pendingImport.value.canLoad) return false;
  const item = pendingImport.value;
  Object.assign(draft, {
    title: String(item.meta.名称 || draft.title), description: String(item.meta.简介 || ''), tagsText: String(item.meta.标签 || ''), sortOrder: Number(item.meta.排序) || 0,
    shareTitle: String(item.meta.分享标题 || ''), shareDescription: String(item.meta.分享说明 || ''), content: item.content
  });
  relationForm.fromPersonId = item.content.persons[0]?._id || '';
  relationForm.toPersonId = item.content.persons[1]?._id || '';
  pendingImport.value = null;
  notice.value = '';
  return true;
}
function loadImportForEditing(): void {
  if (!applyPendingImport()) return;
  error.value = `导入内容已载入本地草稿，请修正全部 ${validationIssues.value.length} 项问题后再保存。`;
  if (validationIssues.value.length) focusIssue(validationIssues.value[0]);
}
async function confirmImport(): Promise<void> {
  if (!pendingImport.value || pendingImport.value.issues.length || !applyPendingImport()) return;
  await saveDraft();
}

onMounted(loadList);
</script>

<template>
  <section class="example-manager">
    <header class="manager-header">
      <div><p class="eyebrow">OFFICIAL READ-ONLY CONTENT</p><h2>多示例家谱库</h2><p>以姓名维护人物和关系；内部标识仅由服务端生成。</p></div>
      <button class="primary" :disabled="saving" @click="createTemplate">新建示例</button>
    </header>
    <p v-if="error" class="message error">{{ error }} <button v-if="failedSelection" class="retry" @click="retrySelected">重试加载</button><small v-if="failedSelection">错误详情包含请求 ID，可用于日志检索。</small></p>
    <p v-if="notice" class="message success">{{ notice }}</p>
    <div class="manager-layout">
      <aside class="template-list"><input v-model="search" placeholder="搜索名称或 slug"/><select v-model="status"><option value="all">全部状态</option><option value="draft">草稿</option><option value="published">已发布</option><option value="archived">已归档</option></select><button v-for="item in filteredRows" :key="item._id" :class="{ active:selected?._id===item._id }" @click="selectTemplate(item)"><strong>{{ item.title }}</strong><span>{{ item.slug }}</span><small>{{ item.personCount }} 人 · {{ item.relationCount }} 条关系 · {{ item.updatedAt ? new Date(item.updatedAt).toLocaleDateString() : '未更新' }}</small><em :class="item.status">{{ item.status === 'published' ? `已发布 v${item.publishedVersion}` : item.status === 'archived' ? '已归档' : '草稿' }}</em></button><div v-if="loading" class="state">正在读取示例…</div></aside>
      <section v-if="selected" class="editor">
        <div class="editor-actions">
          <button class="secondary" :disabled="saving" :aria-disabled="Boolean(validationIssues.length)" @click="saveDraft">{{ dirty ? '保存草稿 *' : '草稿已保存' }}</button>
          <button class="secondary" @click="downloadTemplate">下载模板</button><button class="secondary" @click="exportExcel">导出 Excel</button><button class="secondary" @click="exportCsv">导出 CSV</button><button class="secondary" @click="openImport">导入表格</button>
          <input ref="fileInput" class="hidden" type="file" accept=".xlsx,.xls,.csv" multiple @change="importFiles"/>
          <template v-if="isSuperAdmin"><button v-if="selected.status !== 'archived'" class="primary publish-button" :disabled="saving || dirty || Boolean(validationIssues.length)" @click="runAction('examples.publish')">{{ selected.status === 'published' ? '发布更新' : '发布' }}</button><button v-if="selected.status === 'published'" class="secondary" :disabled="saving" @click="runAction('examples.unpublish')">下架</button><button v-if="selected.status !== 'published'" class="danger-button" :disabled="saving" @click="runAction('examples.archive')">归档</button></template>
        </div>
        <nav class="editor-tabs" role="tablist" aria-label="示例家谱编辑区">
          <button v-for="tab in editorTabs" :key="tab.key" type="button" role="tab" :id="`example-tab-${tab.key}`" :aria-selected="activeTab === tab.key" :aria-controls="`example-panel-${tab.key}`" :class="{ active: activeTab === tab.key }" @click="activeTab = tab.key">{{ tab.label }}</button>
        </nav>
        <section v-if="displayedIssues.length" id="example-validation-summary" class="validation-summary" aria-live="polite">
          <div><h3>发现 {{ displayedIssues.length }} 项问题</h3><p>点击下列错误可定位到对应人物或关系；全部修正后才能保存和发布。</p></div>
          <div v-if="groupedDraftIssues.person.length" class="issue-group"><strong>人物问题</strong><button v-for="(item,index) in groupedDraftIssues.person" :key="issueKey(item,index)" @click="focusIssue(item)">{{ item.message }}</button></div>
          <div v-if="groupedDraftIssues.relation.length" class="issue-group"><strong>关系问题</strong><button v-for="(item,index) in groupedDraftIssues.relation" :key="issueKey(item,index)" @click="focusIssue(item)">{{ item.message }}</button></div>
          <div v-if="groupedDraftIssues.content.length" class="issue-group"><strong>整体问题</strong><button v-for="(item,index) in groupedDraftIssues.content" :key="issueKey(item,index)" @click="focusIssue(item)">{{ item.message }}</button></div>
        </section>
        <section v-if="activeTab === 'details'" id="example-panel-details" class="editor-section" role="tabpanel" aria-labelledby="example-tab-details"><h3>家谱资料</h3><div class="field-grid"><label>示例名称<input v-model="draft.title"/></label><label>稳定链接标识<input v-model="draft.slug" disabled/></label><label>标签<input v-model="draft.tagsText" placeholder="用逗号分隔"/></label><label>排序<input v-model.number="draft.sortOrder" type="number" min="0"/></label><label class="wide">简介<textarea v-model="draft.description"/></label><label>微信分享标题<input v-model="draft.shareTitle"/></label><label>微信分享说明<input v-model="draft.shareDescription"/></label></div><div v-if="versions.length" class="versions-section"><h3>发布版本</h3><div class="versions"><article v-for="version in versions" :key="version._id"><span>v{{ version.version }}</span><small>{{ version.publishedByName || '运营人员' }} · {{ new Date(version.publishedAt).toLocaleString('zh-CN') }}</small><button v-if="isSuperAdmin" class="secondary compact" @click="runAction('examples.rollback',{versionId:version._id})">回滚到此版本</button></article></div></div></section>
        <section v-if="activeTab === 'persons'" id="example-panel-persons" class="editor-section" role="tabpanel" aria-labelledby="example-tab-persons">
          <div class="section-head"><div><h3>人物表（{{ draft.content.persons.length }}）</h3><p class="muted">姓名必须唯一，用于维护所有关系。</p></div><div><input v-model="personSearch" placeholder="筛选姓名"/><button class="secondary compact" @click="addPerson">添加人物</button></div></div>
          <div class="table-wrap"><table><thead><tr><th>#</th><th>姓名</th><th>性别</th><th>状态</th><th>出生</th><th>去世</th><th>籍贯</th><th>简介</th><th></th></tr></thead><tbody><template v-for="entry in visiblePersons" :key="entry.person._id"><tr :id="`person-${entry.person._id}`" :class="{ selected:selectedPersonId===entry.person._id, invalid:rowIssues('person',entry.index).length }" @click="selectedPersonId=entry.person._id"><td>{{ entry.index + 1 }}</td><td><input v-model="entry.person.name" placeholder="唯一姓名"/></td><td><select v-model="entry.person.gender"><option value="unknown">未填写</option><option value="male">男</option><option value="female">女</option></select></td><td><select v-model="entry.person.lifeStatus"><option value="unknown">未填写</option><option value="living">健在</option><option value="deceased">已故</option></select></td><td><input v-model="entry.person.birthDate" placeholder="YYYY-MM-DD"/></td><td><input v-model="entry.person.deathDate" placeholder="YYYY-MM-DD"/></td><td><input v-model="entry.person.birthPlace"/></td><td><input v-model="entry.person.bio"/></td><td><button class="text-danger" @click.stop="removePerson(entry.person._id)">删除</button></td></tr><tr v-if="rowIssues('person',entry.index).length" class="inline-issues"><td colspan="9"><span v-for="(item,index) in rowIssues('person',entry.index)" :key="issueKey(item,index)">{{ item.message }}</span></td></tr></template></tbody></table></div>
        </section>
        <section v-if="activeTab === 'relations'" id="example-panel-relations" class="editor-section" role="tabpanel" aria-labelledby="example-tab-relations">
          <div class="section-head"><div><h3>关系表（{{ draft.content.relations.length }}）</h3><p class="muted">用人物姓名建立关系，不需要填写任何 ID。</p></div><div class="relation-create"><select v-model="relationForm.fromPersonId"><option v-for="person in draft.content.persons" :key="person._id" :value="person._id">{{ person.name || '未命名人物' }}</option></select><select v-model="relationForm.type"><option value="parent_child">父母 → 子女</option><option value="spouse">伴侣</option></select><select v-model="relationForm.toPersonId"><option v-for="person in draft.content.persons" :key="person._id" :value="person._id">{{ person.name || '未命名人物' }}</option></select><button class="secondary compact" @click="addRelation">添加关系</button></div></div>
          <div class="table-wrap"><table><thead><tr><th>#</th><th>起始人物</th><th>关系类型</th><th>结束人物</th><th></th></tr></thead><tbody><template v-for="entry in relationRows" :key="entry.relation._id"><tr :id="`relation-${entry.relation._id}`" :class="{ selected:selectedRelationId===entry.relation._id, invalid:rowIssues('relation',entry.index).length }" @click="selectedRelationId=entry.relation._id"><td>{{ entry.index + 1 }}</td><td><select v-model="entry.relation.fromPersonId"><option v-if="!personExists(entry.relation.fromPersonId)" :value="entry.relation.fromPersonId" disabled>未匹配：{{ entry.relation.fromName || '未填写' }}</option><option v-for="person in draft.content.persons" :key="person._id" :value="person._id">{{ person.name || '未命名人物' }}</option></select></td><td><select v-model="entry.relation.type"><option v-if="!validRelationType(entry.relation.type)" :value="entry.relation.type" disabled>无效类型：{{ entry.relation.type || '空' }}</option><option value="parent_child">父母 → 子女</option><option value="spouse">伴侣</option></select></td><td><select v-model="entry.relation.toPersonId"><option v-if="!personExists(entry.relation.toPersonId)" :value="entry.relation.toPersonId" disabled>未匹配：{{ entry.relation.toName || '未填写' }}</option><option v-for="person in draft.content.persons" :key="person._id" :value="person._id">{{ person.name || '未命名人物' }}</option></select></td><td><button class="text-danger" @click.stop="removeRelation(entry.relation._id)">删除</button></td></tr><tr v-if="rowIssues('relation',entry.index).length" class="inline-issues"><td colspan="5"><span v-for="(item,issueIndex) in rowIssues('relation',entry.index)" :key="issueKey(item,issueIndex)">{{ item.message }}</span></td></tr></template></tbody></table></div>
        </section>
        <section v-if="activeTab === 'preview'" id="example-panel-preview" class="editor-section" role="tabpanel" aria-labelledby="example-tab-preview"><h3>关系图校对（图谱预览）</h3><p class="muted">预览使用当前草稿默认展示设置；点击人物或关系线可定位到对应表格行。</p><ExampleGraphPreview :persons="draft.content.persons" :relations="draft.content.relations" :display-preference="draft.displayPreference" :selected-person-id="selectedPersonId" :selected-relation-id="selectedRelationId" @select-person="scrollTo('person',$event)" @select-relation="scrollTo('relation',$event)"/></section>
        <section v-if="activeTab === 'display'" id="example-panel-display" class="editor-section display-settings" role="tabpanel" aria-labelledby="example-tab-display">
          <h3>默认展示</h3><p class="muted">保存草稿后由超级管理员发布更新。新发布版本会让用户采用本页默认展示，用户之后仍可自行调整。</p>
          <div class="display-group"><h4>姓名排列</h4><div class="display-layout"><label><input v-model="draft.displayPreference.nameLayout" type="radio" value="horizontal"/>横排 <span>张建国</span></label><label><input v-model="draft.displayPreference.nameLayout" type="radio" value="vertical"/>竖排 <span>张<br/>建<br/>国</span></label></div></div>
          <div class="display-group"><h4>节点标识</h4><label class="display-row"><span><strong>显示子女排行</strong><small>在节点上显示长子、次子、长女等标识</small></span><input v-model="draft.displayPreference.showChildRankBadge" type="checkbox"/></label><label class="display-row"><span><strong>显示性别标识</strong><small>在节点上显示男、女文字标识</small></span><input v-model="draft.displayPreference.showGenderBadge" type="checkbox"/></label><label class="display-row"><span><strong>使用性别配色</strong><small>用不同颜色区分男女人物节点</small></span><input v-model="draft.displayPreference.showGenderColors" type="checkbox"/></label></div>
          <div class="display-group"><h4>浏览体验</h4><label class="display-row"><span><strong>智能收起</strong><small>家谱人数较多时自动收起部分分支，让画面更加流畅</small></span><input v-model="draft.displayPreference.autoCollapseEnabled" type="checkbox"/></label></div>
        </section>
      </section>
      <section v-else class="editor empty"><h3>选择或新建一个示例</h3></section>
    </div>
    <div v-if="pendingImport" class="import-mask"><section class="import-dialog"><h3>导入预览</h3><p>将整体替换当前草稿：{{ pendingImport.content.persons.length }} 人、{{ pendingImport.content.relations.length }} 条关系。</p><div v-if="pendingImport.issues.length" class="import-issues"><section v-if="pendingImportGroups.person.length"><h4>人物问题（{{ pendingImportGroups.person.length }}）</h4><ul><li v-for="(item,index) in pendingImportGroups.person" :key="issueKey(item,index)">{{ item.message }}</li></ul></section><section v-if="pendingImportGroups.relation.length"><h4>关系问题（{{ pendingImportGroups.relation.length }}）</h4><ul><li v-for="(item,index) in pendingImportGroups.relation" :key="issueKey(item,index)">{{ item.message }}</li></ul></section><section v-if="pendingImportGroups.content.length"><h4>整体问题（{{ pendingImportGroups.content.length }}）</h4><ul><li v-for="(item,index) in pendingImportGroups.content" :key="issueKey(item,index)">{{ item.message }}</li></ul></section></div><p v-else class="ok">姓名与关系校验通过；确认后由服务端生成隐藏 ID 并完成最终校验。</p><div class="import-actions"><button class="secondary" @click="pendingImport=null">取消</button><button v-if="pendingImport.issues.length && pendingImport.canLoad" class="secondary" @click="loadImportForEditing">载入草稿修改</button><button v-if="!pendingImport.issues.length" class="primary" :disabled="saving" @click="confirmImport">确认覆盖并保存</button></div></section></div>
  </section>
</template>

<style scoped>
.example-manager{min-height:560px}.manager-header,.editor-actions,.section-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.manager-header{margin-bottom:20px}.manager-header h2{margin:0;font:650 30px/1.15 Georgia,"Noto Serif SC",serif}.manager-header p:not(.eyebrow),.muted{color:#65706a}.muted{margin:5px 0 0;font-size:12px}.message{padding:12px;border-radius:10px}.error{color:#9f3030;background:#fff0ee}.error small{margin-left:8px;color:#8a5b5b}.retry{margin-left:8px;color:inherit;background:transparent;border:0;text-decoration:underline}.success,.ok{color:#286147;background:#edf7f1}.manager-layout{display:grid;grid-template-columns:280px minmax(0,1fr);background:#fff;border:1px solid #dfe5e1;border-radius:18px}.template-list{min-height:650px;padding:12px;background:#f6f8f5;border-right:1px solid #e4e9e5}.template-list>input,.template-list>select{width:100%;margin-bottom:8px}.template-list button{width:100%;margin-bottom:8px;padding:12px;display:grid;gap:4px;background:#fff;border:1px solid #e0e6e2;border-radius:11px;text-align:left}.template-list button.active,.selected{outline:2px solid #245c4a;background:#edf7f1!important}.template-list span,.template-list small{overflow:hidden;color:#718079;font-size:11px;text-overflow:ellipsis;white-space:nowrap}.template-list em{width:max-content;padding:3px 7px;color:#85601b;background:#fff1d8;border-radius:99px;font-size:10px;font-style:normal}.template-list em.published{color:#346352;background:#e7f0ec}.template-list em.archived{color:#6e7772;background:#edf0ee}.editor{min-width:0;padding:24px}.editor.empty{display:grid;place-content:center}.editor-actions{position:sticky;top:0;z-index:3;padding-bottom:16px;background:#fff;flex-wrap:wrap}.editor-actions button[aria-disabled="true"]{border-color:#d8aaa4;color:#9f3030}.editor-section{margin-top:22px;padding-top:22px;border-top:1px solid #e8ece9}.editor-section h3{margin:0 0 8px}.field-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.field-grid label{display:grid;gap:6px;font-size:12px;font-weight:700}.wide{grid-column:1/-1}.field-grid textarea{min-height:64px}.validation-summary{display:grid;gap:10px;padding:14px 16px;border:1px solid #e1aaa3;border-radius:12px;color:#7f2929;background:#fff5f3}.validation-summary h3,.validation-summary p{margin:0}.validation-summary p{margin-top:4px;font-size:12px}.issue-group{display:grid;gap:5px}.issue-group button{padding:0;border:0;color:#9f3030;background:transparent;text-align:left;text-decoration:underline;cursor:pointer}.table-wrap{overflow:auto;border:1px solid #e3e8e4;border-radius:10px}table{width:100%;border-collapse:collapse;font-size:12px}th,td{padding:8px;border-bottom:1px solid #edf0ee;white-space:nowrap;text-align:left}th{color:#65706a;background:#f7f9f7}td input,td select{min-width:86px;padding:5px}tr.invalid>td{background:#fff5f3}tr.invalid input,tr.invalid select{border-color:#cc7469}.inline-issues td{padding:6px 12px;color:#9f3030;background:#fff0ee;white-space:normal}.inline-issues span{display:block}.relation-create{display:flex;gap:6px}.relation-create select{max-width:160px}.compact{min-height:32px;padding:0 10px}.text-danger{color:#a13333;background:transparent;border:0;font-weight:700}.versions article{padding:10px;display:grid;grid-template-columns:55px 1fr auto;gap:8px;background:#f8faf7;border:1px solid #e3e8e4;border-radius:10px}.hidden{display:none}.import-mask{position:fixed;z-index:20;inset:0;display:grid;place-items:center;background:rgba(23,35,31,.42)}.import-dialog{width:min(720px,calc(100vw - 40px));max-height:calc(100vh - 48px);overflow:auto;padding:24px;background:#fff;border-radius:16px}.import-issues{display:grid;gap:12px}.import-issues section{padding:10px 12px;border-radius:9px;background:#fff5f3}.import-issues h4{margin:0 0 5px;color:#7f2929}.import-dialog ul{margin:0;padding-left:22px;color:#9f3030}.import-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}@media(max-width:900px){.manager-layout{grid-template-columns:1fr}.template-list{min-height:0;border-right:0;border-bottom:1px solid #e4e9e5}.field-grid{grid-template-columns:1fr}.relation-create{flex-wrap:wrap}}
.editor-tabs{display:flex;gap:5px;overflow-x:auto;border-bottom:1px solid #dfe7e2}.editor-tabs button{flex:none;padding:11px 14px;border:0;border-bottom:3px solid transparent;border-radius:0;background:transparent;color:#65706a;font-weight:700;cursor:pointer}.editor-tabs button.active{border-bottom-color:#245c4a;color:#245c4a}.editor-tabs button:focus-visible{outline:2px solid #245c4a;outline-offset:-3px}.versions-section{margin-top:28px;padding-top:20px;border-top:1px solid #e8ece9}.versions{display:grid;gap:8px}.display-settings{max-width:780px}.display-group{margin-top:22px;border:1px solid #dfe7e2;border-radius:12px;overflow:hidden}.display-group h4{margin:0;padding:12px 15px;background:#f6f8f5}.display-layout{display:flex;gap:12px;padding:16px}.display-layout label{flex:1;display:flex;align-items:center;gap:8px;min-height:90px;padding:14px;border:1px solid #dfe7e2;border-radius:10px;cursor:pointer}.display-layout label:has(input:checked){border-color:#245c4a;background:#edf7f1}.display-layout span{margin-left:auto;font-size:18px;line-height:1.1}.display-row{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:13px 16px;border-top:1px solid #e8ece9;cursor:pointer}.display-row span{display:grid;gap:4px}.display-row small{color:#65706a;font-size:12px}.display-row input{width:18px;height:18px;accent-color:#245c4a}@media(max-width:560px){.display-layout{flex-direction:column}}
</style>
