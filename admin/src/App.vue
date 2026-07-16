<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { callOps, getErrorMessage, hasLoginState, signIn, signOut } from './cloudbase';

type ModuleKey = 'dashboard' | 'users' | 'families' | 'reports' | 'moderation' | 'deletions' | 'audits' | 'operators';
type ModerationScope = 'pending' | 'reviewed';
type Row = Record<string, any>;

type MediaPreview = Row & {
  type: 'image' | 'text';
  taskId: string;
  status: string;
  available: boolean;
  url?: string;
  text?: string;
  unavailableReason?: string;
};

interface Operator {
  _id: string;
  displayName: string;
  email: string;
  role: 'super_admin' | 'operator';
}

interface PageResult {
  items: Row[];
  nextCursor: string;
  hasMore: boolean;
}

const navItems: Array<{ key: ModuleKey; label: string; caption: string }> = [
  { key: 'dashboard', label: '概览', caption: '运行状态' },
  { key: 'users', label: '用户', caption: '账号处置' },
  { key: 'families', label: '家谱', caption: '风险治理' },
  { key: 'reports', label: '举报', caption: '工单闭环' },
  { key: 'moderation', label: '内容复核', caption: '图片审核' },
  { key: 'deletions', label: '注销工单', caption: '数据权利' },
  { key: 'audits', label: '审计日志', caption: '操作留痕' },
  { key: 'operators', label: '运营账号', caption: '白名单' }
];

const actionByModule: Record<Exclude<ModuleKey, 'dashboard'>, string> = {
  users: 'users.list',
  families: 'families.list',
  reports: 'reports.list',
  moderation: 'moderation.list',
  deletions: 'deletions.list',
  audits: 'audits.list',
  operators: 'operators.list'
};

const login = reactive({ email: '', password: '', loading: false, error: '' });
const booting = ref(true);
const authenticated = ref(false);
const operator = ref<Operator | null>(null);
const activeModule = ref<ModuleKey>('dashboard');
const moderationScope = ref<ModerationScope>('pending');
const loading = ref(false);
const error = ref('');
const notice = ref('');
const rows = ref<Row[]>([]);
const nextCursor = ref('');
const hasMore = ref(false);
const totals = reactive({ activeUsers: 0, activeFamilies: 0, reportBacklog: 0, moderationBacklog: 0, deletionBacklog: 0 });
const dialog = reactive({
  open: false,
  title: '',
  message: '',
  reason: '',
  confirmText: '确认',
  danger: false,
  action: '' as string,
  payload: {} as Record<string, unknown>
});
const detail = ref<Row | null>(null);
const detailKind = ref<'family' | 'user' | 'report'>('family');
const familyPeople = reactive({
  familyId: '', keyword: '', items: [] as Row[], nextCursor: '', hasMore: false, loading: false, error: ''
});
const personDetail = ref<Row | null>(null);
let familyPeopleRequest = 0;
const mediaPreview = ref<MediaPreview | null>(null);
const operatorForm = reactive({ open: false, authUid: '', displayName: '', email: '', role: 'operator' });

const visibleNav = computed(() => navItems.filter((item) => !['operators', 'audits'].includes(item.key) || operator.value?.role === 'super_admin'));
const currentNav = computed(() => navItems.find((item) => item.key === activeModule.value) || navItems[0]);
const dialogNeedsReason = computed(() => dialog.action === 'reports.resolve' || (
  dialog.action === 'moderation.review' && dialog.payload.decision === 'reject'
));

function formatDate(value: unknown): string {
  if (!value) return '—';
  const date = new Date(value as string);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
}

function statusLabel(value: string): string {
  const labels: Record<string, string> = {
    active: '正常', frozen: '已冻结', archived: '回收站', deleting: '删除中',
    open: '待处理', processing: '处理中', resolved: '已解决', rejected: '已驳回',
    pending: '待执行', failed: '失败', completed: '已完成', cancelled: '已撤销',
    review: '待人工复核', approved: '已通过', disabled: '已停用'
  };
  return labels[value] || value || '—';
}

function moderationStatusLabel(value: string): string {
  const labels: Record<string, string> = {
    pending: '机器审核中', review: '待人工复核', approved: '已通过', rejected: '已拒绝'
  };
  return labels[value] || statusLabel(value);
}

function reviewSourceLabel(value: string): string {
  return value === 'manual' ? '人工复核' : '机器审核';
}

function roleLabel(value: string): string {
  const labels: Record<string, string> = {
    admin: '管理员', member: '家庭成员', viewer: '访客',
    super_admin: '超级管理员', operator: '运营人员'
  };
  return labels[value] || value || '—';
}

function targetTypeLabel(value: string): string {
  const labels: Record<string, string> = {
    person: '人物资料', avatar: '人物头像', family: '家谱资料',
    description: '家谱简介', invite: '邀请链接', media: '图片内容'
  };
  return labels[value] || value || '未标明';
}

function genderLabel(value: string): string {
  return value === 'male' ? '男' : value === 'female' ? '女' : '未填写';
}

function lifeStatusLabel(value: string): string {
  return value === 'alive' ? '在世' : value === 'deceased' ? '已故' : '未填写';
}

function avatarStatusLabel(value: string): string {
  const labels: Record<string, string> = {
    none: '无头像', pending: '审核中', review: '待复核', approved: '已通过', rejected: '已拒绝', active: '已通过'
  };
  return labels[value] || '待确认';
}

function operationLabel(value: string): string {
  const labels: Record<string, string> = {
    'ops.family.freeze': '冻结家谱', 'ops.family.unfreeze': '解除冻结',
    'ops.family.person.view': '查看人物资料'
  };
  return labels[value] || value || '运营操作';
}

function lifeYears(person: Row): string {
  const birth = person.birthDate ? String(person.birthDate).slice(0, 4) : '';
  const death = person.deathDate ? String(person.deathDate).slice(0, 4) : '';
  if (birth && death) return `${birth}—${death}`;
  if (birth) return `${birth} 年生`;
  if (death) return `${death} 年卒`;
  return '生卒年未填写';
}

function countActiveMemberships(items: Row[] | undefined): number {
  return Array.isArray(items) ? items.filter((item) => item.status === 'active').length : 0;
}

async function bootstrap(): Promise<void> {
  try {
    if (!(await hasLoginState())) return;
    const data = await callOps<{ operator: Operator }>('session.me');
    operator.value = data.operator;
    authenticated.value = true;
    await loadModule('dashboard');
  } catch (err) {
    await signOut().catch(() => undefined);
    login.error = getErrorMessage(err, '登录状态无效');
    authenticated.value = false;
  } finally {
    booting.value = false;
  }
}

async function submitLogin(): Promise<void> {
  if (!login.email || !login.password || login.loading) return;
  login.loading = true;
  login.error = '';
  let signedIn = false;
  try {
    await signIn(login.email.trim(), login.password);
    signedIn = true;
    const data = await callOps<{ operator: Operator }>('session.me');
    operator.value = data.operator;
    authenticated.value = true;
    await loadModule('dashboard');
  } catch (err) {
    if (signedIn) await signOut().catch(() => undefined);
    login.error = getErrorMessage(err, '登录失败');
  } finally {
    login.loading = false;
  }
}

async function logout(): Promise<void> {
  await signOut();
  authenticated.value = false;
  operator.value = null;
  rows.value = [];
}

async function loadModule(module: ModuleKey, append = false): Promise<void> {
  if (module === 'moderation' && activeModule.value !== 'moderation') moderationScope.value = 'pending';
  activeModule.value = module;
  if (module !== 'moderation') notice.value = '';
  loading.value = true;
  error.value = '';
  detail.value = null;
  personDetail.value = null;
  try {
    if (module === 'dashboard') {
      const data = await callOps<{ totals: typeof totals }>('dashboard.summary');
      Object.assign(totals, data.totals);
      rows.value = [];
      nextCursor.value = '';
      hasMore.value = false;
      return;
    }
    const params: Record<string, unknown> = {
      pageSize: 25,
      cursor: append ? nextCursor.value : ''
    };
    if (module === 'moderation') params.scope = moderationScope.value;
    const data = await callOps<PageResult>(actionByModule[module], params);
    rows.value = append ? rows.value.concat(data.items) : data.items;
    nextCursor.value = data.nextCursor;
    hasMore.value = data.hasMore;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '数据加载失败';
  } finally {
    loading.value = false;
  }
}

async function switchModerationScope(scope: ModerationScope): Promise<void> {
  if (moderationScope.value === scope || loading.value) return;
  moderationScope.value = scope;
  mediaPreview.value = null;
  rows.value = [];
  nextCursor.value = '';
  hasMore.value = false;
  await loadModule('moderation');
}

function openAction(title: string, message: string, action: string, payload: Record<string, unknown>, danger = false, confirmText = '确认'): void {
  Object.assign(dialog, { open: true, title, message, reason: '', action, payload, danger, confirmText });
}

async function confirmAction(): Promise<void> {
  if (dialogNeedsReason.value && !dialog.reason.trim()) return;
  loading.value = true;
  try {
    const payload: Record<string, unknown> = { ...dialog.payload };
    if (dialog.action === 'reports.resolve') {
      payload.resolution = dialog.reason.trim();
    }
    if (dialog.action === 'moderation.review' && dialog.payload.decision === 'reject') {
      payload.reason = dialog.reason.trim();
    }
    await callOps(dialog.action, payload);
    if (dialog.action === 'moderation.review') {
      notice.value = dialog.payload.decision === 'approve'
        ? '内容已通过，审核结果已写入审核记录。'
        : '内容已拒绝，审核结果和原因已写入审核记录。';
      mediaPreview.value = null;
    }
    dialog.open = false;
    await loadModule(activeModule.value);
  } catch (err) {
    error.value = err instanceof Error ? err.message : '操作失败';
  } finally {
    loading.value = false;
  }
}

async function viewUser(row: Row): Promise<void> {
  try {
    detail.value = await callOps<Row>('users.detail', { userId: row._id });
    detailKind.value = 'user';
  } catch (err) {
    error.value = err instanceof Error ? err.message : '详情加载失败';
  }
}

async function viewFamily(row: Row): Promise<void> {
  try {
    detail.value = await callOps<Row>('families.detail', { familyId: row._id });
    detailKind.value = 'family';
    personDetail.value = null;
    Object.assign(familyPeople, { familyId: row._id, keyword: '', items: [], nextCursor: '', hasMore: false, error: '' });
    await loadFamilyPeople(true);
  } catch (err) {
    error.value = err instanceof Error ? err.message : '家谱详情加载失败';
  }
}

async function loadFamilyPeople(reset = false): Promise<void> {
  if (!familyPeople.familyId || familyPeople.loading) return;
  const request = ++familyPeopleRequest;
  familyPeople.loading = true;
  familyPeople.error = '';
  if (reset) {
    familyPeople.items = [];
    familyPeople.nextCursor = '';
    familyPeople.hasMore = false;
  }
  try {
    const data = await callOps<PageResult>('families.persons', {
      familyId: familyPeople.familyId,
      keyword: familyPeople.keyword.trim(),
      pageSize: 20,
      cursor: reset ? '' : familyPeople.nextCursor
    });
    if (request !== familyPeopleRequest) return;
    familyPeople.items = reset ? data.items : familyPeople.items.concat(data.items);
    familyPeople.nextCursor = data.nextCursor;
    familyPeople.hasMore = data.hasMore;
  } catch (err) {
    if (request === familyPeopleRequest) familyPeople.error = err instanceof Error ? err.message : '人物列表加载失败';
  } finally {
    if (request === familyPeopleRequest) familyPeople.loading = false;
  }
}

async function searchFamilyPeople(): Promise<void> {
  familyPeopleRequest += 1;
  familyPeople.loading = false;
  await loadFamilyPeople(true);
}

async function viewFamilyPerson(person: Row): Promise<void> {
  try {
    personDetail.value = await callOps<Row>('families.personDetail', {
      familyId: familyPeople.familyId,
      personId: person._id
    });
  } catch (err) {
    familyPeople.error = err instanceof Error ? err.message : '人物详情加载失败';
  }
}

async function previewMedia(row: Row): Promise<void> {
  try {
    const preview = await callOps<MediaPreview>('moderation.getUrl', {
      taskId: row._id
    });
    mediaPreview.value = { ...row, ...preview };
  } catch (err) {
    error.value = err instanceof Error ? err.message : '内容预览失败';
  }
}

async function viewReport(row: Row): Promise<void> {
  try {
    detail.value = await callOps<Row>('reports.detail', { reportId: row._id });
    detailKind.value = 'report';
  } catch (err) {
    error.value = err instanceof Error ? err.message : '举报详情加载失败';
  }
}

async function createOperator(): Promise<void> {
  if (!operatorForm.authUid || !operatorForm.displayName) return;
  try {
    await callOps('operators.create', {
      authUid: operatorForm.authUid.trim(),
      displayName: operatorForm.displayName.trim(),
      email: operatorForm.email.trim(),
      role: operatorForm.role
    });
    operatorForm.open = false;
    operatorForm.authUid = '';
    operatorForm.displayName = '';
    operatorForm.email = '';
    await loadModule('operators');
  } catch (err) {
    error.value = err instanceof Error ? err.message : '创建失败';
  }
}

onMounted(bootstrap);
</script>

<template>
  <div v-if="booting" class="boot-screen"><div class="spinner"></div><p>正在验证运营身份...</p></div>

  <main v-else-if="!authenticated" class="login-page">
    <section class="login-copy"><div class="brand-mark">谱</div><p class="eyebrow">YOUPU OPERATIONS</p><h1>让每一份家谱<br />都被稳妥地守护</h1><p>运营后台只处理必要的安全、举报与数据权利工单。所有访问都会留下审计记录。</p></section>
    <form class="login-card" aria-describedby="login-help login-error" @submit.prevent="submitLogin">
      <div><p class="eyebrow">运营人员登录</p><h2>欢迎回来</h2><p class="muted">仅限白名单中的 CloudBase 邮箱账号。</p></div>
      <label>邮箱<input v-model="login.email" type="email" inputmode="email" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="operator@example.com" :disabled="login.loading" required /></label>
      <label>密码<input v-model="login.password" type="password" autocomplete="current-password" placeholder="请输入密码" :disabled="login.loading" required /></label>
      <p id="login-help" class="login-help">账号需同时存在于 CloudBase 用户列表和运营白名单中。</p>
      <p v-if="login.error" id="login-error" class="form-error" role="alert" aria-live="polite">{{ login.error }}</p>
      <button class="primary" type="submit" :disabled="login.loading">{{ login.loading ? '正在验证...' : '安全登录' }}</button>
    </form>
  </main>

  <div v-else class="app-shell">
    <aside class="sidebar">
      <div class="sidebar-brand"><div class="brand-mark small">谱</div><div><strong>有谱</strong><span>运营控制台</span></div></div>
      <nav><button v-for="item in visibleNav" :key="item.key" :class="{ active: activeModule === item.key }" @click="loadModule(item.key)"><span>{{ item.label }}</span><small>{{ item.caption }}</small></button></nav>
      <div class="operator-card"><div class="operator-avatar">{{ operator?.displayName?.slice(0, 1) }}</div><div><strong>{{ operator?.displayName }}</strong><span>{{ operator?.role === 'super_admin' ? '超级管理员' : '运营人员' }}</span></div><button @click="logout">退出</button></div>
    </aside>

    <main class="workspace">
      <header><div><p class="eyebrow">{{ currentNav.caption }}</p><h1>{{ currentNav.label }}</h1></div><div class="header-actions"><button v-if="activeModule === 'operators' && operator?.role === 'super_admin'" class="primary compact" @click="operatorForm.open = true">新增运营账号</button><button class="secondary compact" :disabled="loading" @click="loadModule(activeModule)">刷新数据</button></div></header>

      <p v-if="error" class="alert">{{ error }} <button @click="error = ''">关闭</button></p>
      <p v-if="notice" class="alert success" role="status">{{ notice }} <button @click="notice = ''">关闭</button></p>

      <section v-if="activeModule === 'dashboard'" class="dashboard-grid">
        <article><span>活跃用户</span><strong>{{ totals.activeUsers }}</strong><small>当前可用账号</small></article>
        <article><span>活跃家谱</span><strong>{{ totals.activeFamilies }}</strong><small>未归档、未冻结</small></article>
        <article :class="{ attention: totals.reportBacklog > 0 }"><span>举报待办</span><strong>{{ totals.reportBacklog }}</strong><small>待领取或处理中</small></article>
        <article :class="{ attention: totals.moderationBacklog > 0 }"><span>内容复核</span><strong>{{ totals.moderationBacklog }}</strong><small>机器疑似与审核中</small></article>
        <article :class="{ attention: totals.deletionBacklog > 0 }"><span>注销任务</span><strong>{{ totals.deletionBacklog }}</strong><small>待执行或失败</small></article>
        <article class="principle-card"><span>今日原则</span><strong>访问可追溯</strong><small>查看家庭资料时自动记录运营账号与访问对象。</small></article>
      </section>

      <section v-else class="table-card">
        <div v-if="activeModule === 'moderation'" class="moderation-tabs" role="tablist" aria-label="内容复核视图">
          <button role="tab" :aria-selected="moderationScope === 'pending'" :class="{ active: moderationScope === 'pending' }" :disabled="loading" @click="switchModerationScope('pending')">待复核</button>
          <button role="tab" :aria-selected="moderationScope === 'reviewed'" :class="{ active: moderationScope === 'reviewed' }" :disabled="loading" @click="switchModerationScope('reviewed')">审核记录</button>
        </div>
        <div v-if="loading && !rows.length" class="loading-state"><div class="spinner"></div><p>正在读取数据...</p></div>
        <div v-else-if="!rows.length" class="empty-state"><div>空</div><h3>{{ activeModule === 'moderation' && moderationScope === 'pending' ? '当前没有待复核内容' : '当前没有记录' }}</h3><p>{{ activeModule === 'moderation' && moderationScope === 'reviewed' ? '人工复核和机器审核完成后会显示在这里。' : '新的数据会自动显示在这里。' }}</p></div>
        <div v-else class="table-wrap">
          <table>
            <thead><tr><th>标识 / 名称</th><th>类型 / 角色</th><th>状态</th><th>时间</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="row in rows" :key="row._id">
                <td><strong>{{ row.name || row.nickName || row.displayName || row.actorName || row.identity || row.targetType || row.action || row._id }}</strong><small>{{ row.email || row.actorId || row.reason || row.summary || row.familyId || row._id }}</small></td>
                <td><template v-if="activeModule === 'moderation'"><span>{{ row.kind }}</span><small v-if="moderationScope === 'reviewed'" class="source-tag" :class="row.reviewSource">{{ reviewSourceLabel(row.reviewSource) }}</small></template><template v-else>{{ row.role || row.kind || row.objectType || row.targetType || '—' }}</template></td>
                <td><span class="status" :class="row.status || row.moderationStatus">{{ activeModule === 'moderation' ? moderationStatusLabel(row.moderationStatus) : statusLabel(row.status || row.moderationStatus) }}</span></td>
                <td>{{ formatDate(activeModule === 'moderation' && moderationScope === 'reviewed' ? row.decidedAt : row.createdAt || row.requestedAt || row.updatedAt) }}</td>
                <td class="row-actions">
                  <button v-if="activeModule === 'users'" @click="viewUser(row)">查看</button>
                  <button v-if="activeModule === 'users' && operator?.role === 'super_admin' && ['active','frozen'].includes(row.status)" :class="{ danger: row.status !== 'frozen' }" @click="openAction(row.status === 'frozen' ? '解除用户冻结' : '冻结用户', '该操作会立即影响用户访问。', 'users.freeze', { userId: row._id, freeze: row.status !== 'frozen' }, row.status !== 'frozen')">{{ row.status === 'frozen' ? '解冻' : '冻结' }}</button>
                  <button v-if="activeModule === 'families'" @click="viewFamily(row)">查看</button>
                  <button v-if="activeModule === 'families' && operator?.role === 'super_admin' && ['active','archived','frozen'].includes(row.status)" :class="{ danger: row.status !== 'frozen' }" @click="openAction(row.status === 'frozen' ? '解除家谱冻结' : '冻结家谱', '运营人员不能修改家谱内容，只能控制访问状态。', 'families.freeze', { familyId: row._id, freeze: row.status !== 'frozen' }, row.status !== 'frozen')">{{ row.status === 'frozen' ? '解冻' : '冻结' }}</button>
                  <button v-if="activeModule === 'reports' && row.status === 'open'" @click="openAction('领取举报工单', '领取后工单将进入处理中。', 'reports.assign', { reportId: row._id })">领取</button>
                  <button v-if="activeModule === 'reports'" @click="viewReport(row)">详情</button>
                  <button v-if="activeModule === 'reports' && ['open','processing'].includes(row.status)" @click="openAction('解决举报', '填写处理结论，用户将看到工单已完成。', 'reports.resolve', { reportId: row._id, decision: 'resolve', resolution: '' })">解决</button>
                  <button v-if="activeModule === 'reports' && ['open','processing'].includes(row.status)" @click="openAction('驳回举报', '确认举报不成立并填写理由。', 'reports.resolve', { reportId: row._id, decision: 'reject', resolution: '' }, true, '驳回')">驳回</button>
                  <button v-if="activeModule === 'moderation'" @click="previewMedia(row)">{{ moderationScope === 'reviewed' ? '查看记录' : '受控预览' }}</button>
                  <button v-if="activeModule === 'moderation' && moderationScope === 'pending'" @click="openAction('通过内容', '确认内容符合产品规范。', 'moderation.review', { taskId: row._id, decision: 'approve' })">通过</button>
                  <button v-if="activeModule === 'moderation' && moderationScope === 'pending'" class="danger" @click="openAction('拒绝内容', '拒绝后内容不会向家庭成员展示，请填写人工复核原因。', 'moderation.review', { taskId: row._id, decision: 'reject' }, true, '拒绝')">拒绝</button>
                  <button v-if="activeModule === 'deletions' && row.status === 'failed' && operator?.role === 'super_admin'" @click="openAction('重试注销', '任务会由后台维护函数重新执行。', 'deletions.retry', { deletionId: row._id }, true, '重试')">重试</button>
                  <button v-if="activeModule === 'operators' && row.status === 'active'" class="danger" @click="openAction('停用运营账号', '该账号将立即失去运营后台访问权限。', 'operators.disable', { operatorId: row._id }, true, '停用')">停用</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <button v-if="hasMore" class="load-more" :disabled="loading" @click="loadModule(activeModule, true)">{{ loading ? '加载中...' : '加载更多' }}</button>
      </section>

      <section v-if="detail" class="detail-drawer">
        <button class="drawer-close" aria-label="关闭详情" @click="detail = null">×</button>

        <template v-if="detailKind === 'user'">
          <div class="detail-hero">
            <div class="detail-avatar">{{ (detail.user?.nickName || '用').slice(0, 1) }}</div>
            <div class="detail-heading">
              <p class="eyebrow">用户资料 · 已脱敏</p>
              <h2>{{ detail.user?.nickName || '未设置昵称' }}</h2>
              <span class="status" :class="detail.user?.status">{{ statusLabel(detail.user?.status) }}</span>
            </div>
          </div>

          <div class="detail-stats">
            <article><span>加入家谱</span><strong>{{ detail.memberships?.length || 0 }}</strong><small>全部成员关系</small></article>
            <article><span>当前有效</span><strong>{{ countActiveMemberships(detail.memberships) }}</strong><small>正常参与家谱</small></article>
          </div>

          <section class="detail-section">
            <div class="detail-section-title"><h3>账号信息</h3><span>基础资料</span></div>
            <dl class="detail-info-grid">
              <div><dt>用户 ID</dt><dd>{{ detail.user?._id || '—' }}</dd></div>
              <div><dt>身份标识</dt><dd>{{ detail.user?.identity || '—' }}</dd></div>
              <div><dt>注册时间</dt><dd>{{ formatDate(detail.user?.createdAt) }}</dd></div>
              <div><dt>最近更新</dt><dd>{{ formatDate(detail.user?.updatedAt) }}</dd></div>
            </dl>
          </section>

          <section class="detail-section">
            <div class="detail-section-title"><h3>加入的家谱</h3><span>{{ detail.memberships?.length || 0 }} 项</span></div>
            <div v-if="detail.memberships?.length" class="detail-list">
              <article v-for="item in detail.memberships" :key="`${item.familyId}-${item.role}`">
                <div><strong>{{ item.familyId || '未知家谱' }}</strong><small>加入于 {{ formatDate(item.joinedAt) }}</small></div>
                <span class="detail-role">{{ roleLabel(item.role) }}</span>
                <span class="status" :class="item.status">{{ statusLabel(item.status) }}</span>
              </article>
            </div>
            <p v-else class="detail-empty">该用户尚未加入任何家谱。</p>
          </section>
        </template>

        <template v-else-if="detailKind === 'family'">
          <div class="detail-hero">
            <div class="detail-avatar family">谱</div>
            <div class="detail-heading">
              <p class="eyebrow">家谱资料 · 已脱敏</p>
              <h2>{{ detail.family?.name || '未命名家谱' }}</h2>
              <span class="status" :class="detail.family?.status">{{ statusLabel(detail.family?.status) }}</span>
            </div>
          </div>

          <div class="detail-stats three">
            <article><span>人物数量</span><strong>{{ detail.family?.personCount || 0 }}</strong><small>谱内人物</small></article>
            <article><span>关系数量</span><strong>{{ detail.family?.relationCount || 0 }}</strong><small>已建立关系</small></article>
            <article><span>协作者</span><strong>{{ detail.collaborators?.length || 0 }}</strong><small>有效家庭成员</small></article>
          </div>

          <section class="detail-section">
            <div class="detail-section-title"><h3>家谱信息</h3><span>基础资料</span></div>
            <dl class="detail-info-grid">
              <div class="wide"><dt>家谱 ID</dt><dd>{{ detail.family?._id || '—' }}</dd></div>
              <div><dt>创建时间</dt><dd>{{ formatDate(detail.family?.createdAt) }}</dd></div>
              <div><dt>最近更新</dt><dd>{{ formatDate(detail.family?.updatedAt) }}</dd></div>
            </dl>
          </section>

          <section class="detail-section">
            <div class="detail-section-title"><h3>家庭协作者</h3><span>{{ detail.collaborators?.length || 0 }} 人</span></div>
            <div v-if="detail.collaborators?.length" class="detail-list collaborators">
              <article v-for="(item, index) in detail.collaborators" :key="`${item.displayName}-${item.role}-${index}`">
                <div class="mini-avatar">{{ (item.displayName || '家').slice(0, 1) }}</div>
                <div><strong>{{ item.displayName || '家人' }}</strong><small>{{ roleLabel(item.role) }}</small></div>
                <span class="status" :class="item.status">{{ statusLabel(item.status) }}</span>
              </article>
            </div>
            <p v-else class="detail-empty">当前没有有效协作者。</p>
          </section>

          <section class="detail-section people-section">
            <div class="detail-section-title"><h3>谱内人物</h3><span>最多显示 20 人/页</span></div>
            <form class="person-search" @submit.prevent="searchFamilyPeople">
              <input v-model="familyPeople.keyword" maxlength="40" placeholder="输入姓名搜索" aria-label="搜索谱内人物" />
              <button class="primary compact" type="submit" :disabled="familyPeople.loading">搜索</button>
            </form>
            <p v-if="familyPeople.error" class="inline-error">{{ familyPeople.error }}</p>
            <div v-if="familyPeople.items.length" class="person-list">
              <article v-for="person in familyPeople.items" :key="person._id">
                <div class="mini-avatar person">{{ (person.name || '人').slice(0, 1) }}</div>
                <div class="person-main">
                  <div><strong>{{ person.name || '未命名人物' }}</strong><span v-if="person.isStartPerson" class="origin-tag">起始人物</span></div>
                  <small>{{ genderLabel(person.gender) }} · {{ lifeStatusLabel(person.lifeStatus) }} · {{ lifeYears(person) }}</small>
                </div>
                <div class="person-meta"><strong>{{ person.relationCount || 0 }}</strong><small>条关系</small></div>
                <span class="avatar-state" :class="person.avatarStatus">{{ avatarStatusLabel(person.avatarStatus) }}</span>
                <button @click="viewFamilyPerson(person)">详情</button>
              </article>
            </div>
            <div v-else-if="familyPeople.loading" class="inline-loading"><div class="spinner small"></div><span>正在加载人物…</span></div>
            <p v-else class="detail-empty">{{ familyPeople.keyword ? '没有找到匹配的人物。' : '当前家谱还没有人物资料。' }}</p>
            <button v-if="familyPeople.hasMore" class="load-more people-more" :disabled="familyPeople.loading" @click="loadFamilyPeople(false)">{{ familyPeople.loading ? '加载中…' : '加载更多人物' }}</button>
          </section>

          <section class="detail-section">
            <div class="detail-section-title"><h3>举报与内容风险</h3><span>当前待办</span></div>
            <div class="risk-grid">
              <article :class="{ attention: (detail.risk?.reportBacklog || 0) > 0 }"><span>待处理举报</span><strong>{{ detail.risk?.reportBacklog || 0 }}</strong><small>{{ detail.risk?.reportBacklog ? '需要运营跟进' : '当前无待办' }}</small></article>
              <article :class="{ attention: (detail.risk?.moderationBacklog || 0) > 0 }"><span>内容待复核</span><strong>{{ detail.risk?.moderationBacklog || 0 }}</strong><small>{{ detail.risk?.moderationBacklog ? '需要人工判断' : '当前无待办' }}</small></article>
            </div>
          </section>

          <section class="detail-section">
            <div class="detail-section-title"><h3>最近运营记录</h3><span>最近 5 条</span></div>
            <div v-if="detail.recentOperations?.length" class="operation-list">
              <article v-for="item in detail.recentOperations" :key="item._id">
                <div class="operation-dot"></div>
                <div><strong>{{ operationLabel(item.action) }}</strong><small>{{ item.actorAccount }} · {{ formatDate(item.createdAt) }}</small></div>
                <span>{{ item.summary || '运营操作' }}</span>
              </article>
            </div>
            <p v-else class="detail-empty">暂无需要展示的运营动作。</p>
          </section>
        </template>

        <template v-else>
          <div class="detail-hero report">
            <div class="detail-avatar report">举</div>
            <div class="detail-heading">
              <p class="eyebrow">举报资料</p>
              <h2>{{ detail.reason || `${targetTypeLabel(detail.targetType)}举报` }}</h2>
              <span class="status" :class="detail.status">{{ statusLabel(detail.status) }}</span>
            </div>
          </div>

          <section class="detail-section">
            <div class="detail-section-title"><h3>定位信息</h3><span>{{ targetTypeLabel(detail.targetType) }}</span></div>
            <dl class="detail-info-grid">
              <div class="wide"><dt>举报 ID</dt><dd>{{ detail._id || '—' }}</dd></div>
              <div class="wide"><dt>关联家谱</dt><dd>{{ detail.familyId || '—' }}</dd></div>
              <div><dt>举报对象</dt><dd>{{ targetTypeLabel(detail.targetType) }}</dd></div>
              <div><dt>对象 ID</dt><dd>{{ detail.targetId || '—' }}</dd></div>
              <div><dt>举报用户</dt><dd>{{ detail.reporterId || '—' }}</dd></div>
              <div><dt>提交时间</dt><dd>{{ formatDate(detail.createdAt) }}</dd></div>
              <div><dt>最近更新</dt><dd>{{ formatDate(detail.updatedAt) }}</dd></div>
            </dl>
          </section>

          <section class="detail-section">
            <div class="detail-section-title"><h3>举报内容</h3><span>用户提交</span></div>
            <div class="detail-copy"><strong>举报原因</strong><p>{{ detail.reason || '未填写举报原因' }}</p></div>
            <div class="detail-copy"><strong>补充说明</strong><p>{{ detail.detail || '没有补充说明' }}</p></div>
          </section>

          <section v-if="detail.resolution" class="detail-section resolution">
            <div class="detail-section-title"><h3>处理结果</h3><span>{{ statusLabel(detail.status) }}</span></div>
            <p>{{ detail.resolution }}</p>
          </section>
        </template>
      </section>
    </main>

    <div v-if="dialog.open" class="modal-mask" @click.self="dialog.open = false"><section class="modal"><p class="eyebrow">二次确认</p><h2>{{ dialog.title }}</h2><p>{{ dialog.message }}</p><label v-if="dialogNeedsReason">{{ dialog.action === 'reports.resolve' ? '处理结论' : '拒绝原因' }}<textarea v-model="dialog.reason" :maxlength="dialog.action === 'reports.resolve' ? 300 : 200" :placeholder="dialog.action === 'reports.resolve' ? '填写给举报用户查看的处理结果' : '填写内容不符合规范的具体原因'"></textarea></label><div class="modal-actions"><button class="secondary" @click="dialog.open = false">取消</button><button :class="dialog.danger ? 'danger-button' : 'primary'" :disabled="dialogNeedsReason && !dialog.reason.trim()" @click="confirmAction">{{ dialog.confirmText }}</button></div></section></div>

    <div v-if="mediaPreview" class="modal-mask" @click.self="mediaPreview = null">
      <section class="modal media-modal">
        <p class="eyebrow">{{ moderationScope === 'reviewed' ? '审核记录' : '内容预览' }}</p>
        <h2>{{ moderationScope === 'reviewed' ? `${mediaPreview.type === 'text' ? '文字' : '图片'}审核详情` : `待复核${mediaPreview.type === 'text' ? '文字' : '图片'}` }}</h2>
        <dl v-if="moderationScope === 'reviewed'" class="detail-info-grid moderation-record">
          <div class="wide"><dt>任务 ID</dt><dd>{{ mediaPreview.taskId }}</dd></div>
          <div class="wide"><dt>关联家谱</dt><dd>{{ mediaPreview.familyId || '未关联家谱' }}</dd></div>
          <div><dt>审核结果</dt><dd><span class="status" :class="mediaPreview.status">{{ moderationStatusLabel(mediaPreview.status) }}</span></dd></div>
          <div><dt>审核来源</dt><dd>{{ reviewSourceLabel(mediaPreview.reviewSource) }}</dd></div>
          <div><dt>审核人</dt><dd>{{ mediaPreview.reviewerName || '系统审核' }}</dd></div>
          <div><dt>审核时间</dt><dd>{{ formatDate(mediaPreview.decidedAt) }}</dd></div>
          <div class="wide"><dt>审核结论</dt><dd>{{ mediaPreview.reviewReason || '未记录具体结论' }}</dd></div>
        </dl>
        <img v-if="mediaPreview.available && mediaPreview.type === 'image'" :src="mediaPreview.url" alt="受控查看的家庭图片" />
        <pre v-else-if="mediaPreview.available && mediaPreview.type === 'text'" class="moderation-text">{{ mediaPreview.text }}</pre>
        <div v-else class="moderation-unavailable"><strong>原内容已不可查看</strong><p>{{ mediaPreview.unavailableReason || '内容已按保留策略清理。' }}</p></div>
        <p class="muted">本次查看已自动记录运营账号和复核任务。</p>
        <div class="modal-actions single"><button class="secondary" @click="mediaPreview = null">关闭</button></div>
      </section>
    </div>

    <div v-if="personDetail" class="modal-mask" @click.self="personDetail = null">
      <section class="modal person-detail-modal">
        <button class="drawer-close" aria-label="关闭人物详情" @click="personDetail = null">×</button>
        <div class="detail-hero compact-hero">
          <div class="detail-avatar">{{ (personDetail.person?.name || '人').slice(0, 1) }}</div>
          <div class="detail-heading"><p class="eyebrow">谱内人物 · 已脱敏</p><h2>{{ personDetail.person?.name || '未命名人物' }}</h2><span v-if="personDetail.person?.isStartPerson" class="origin-tag">起始人物</span></div>
        </div>
        <dl class="detail-info-grid">
          <div class="wide"><dt>人物 ID</dt><dd>{{ personDetail.person?._id || '—' }}</dd></div>
          <div><dt>性别</dt><dd>{{ genderLabel(personDetail.person?.gender) }}</dd></div>
          <div><dt>生存状态</dt><dd>{{ lifeStatusLabel(personDetail.person?.lifeStatus) }}</dd></div>
          <div><dt>出生日期</dt><dd>{{ personDetail.person?.birthDate || '—' }}</dd></div>
          <div><dt>去世日期</dt><dd>{{ personDetail.person?.deathDate || '—' }}</dd></div>
          <div><dt>出生地</dt><dd>{{ personDetail.person?.birthPlace || '—' }}</dd></div>
          <div><dt>头像状态</dt><dd>{{ avatarStatusLabel(personDetail.person?.avatarStatus) }}</dd></div>
          <div><dt>资料情况</dt><dd>{{ personDetail.person?.hasBio ? '已填写人物简介' : '未填写人物简介' }}</dd></div>
          <div><dt>最近更新</dt><dd>{{ formatDate(personDetail.person?.updatedAt) }}</dd></div>
        </dl>
        <section class="person-relatives">
          <div class="detail-section-title"><h3>直接亲属关系</h3><span>{{ personDetail.relatives?.length || 0 }} 人</span></div>
          <div v-if="personDetail.relatives?.length" class="relative-chips"><span v-for="item in personDetail.relatives" :key="`${item.personId}-${item.role}`"><strong>{{ item.role }}</strong>{{ item.name }}</span></div>
          <p v-else class="detail-empty">暂无直接亲属关系。</p>
        </section>
        <div class="modal-actions single"><button class="secondary" @click="personDetail = null">关闭</button></div>
      </section>
    </div>

    <div v-if="operatorForm.open" class="modal-mask" @click.self="operatorForm.open = false"><section class="modal"><p class="eyebrow">运营白名单</p><h2>新增运营账号</h2><label>CloudBase Auth UID<input v-model="operatorForm.authUid" /></label><label>姓名<input v-model="operatorForm.displayName" /></label><label>邮箱<input v-model="operatorForm.email" type="email" /></label><label>角色<select v-model="operatorForm.role"><option value="operator">运营人员</option><option value="super_admin">超级管理员</option></select></label><div class="modal-actions"><button class="secondary" @click="operatorForm.open = false">取消</button><button class="primary" :disabled="!operatorForm.authUid || !operatorForm.displayName" @click="createOperator">创建账号</button></div></section></div>
  </div>
</template>
