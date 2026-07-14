<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { callOps, hasLoginState, signIn, signOut } from './cloudbase';

type ModuleKey = 'dashboard' | 'users' | 'families' | 'reports' | 'moderation' | 'deletions' | 'audits' | 'operators';
type Row = Record<string, any>;

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
const loading = ref(false);
const error = ref('');
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
const mediaPreview = ref<{ type: 'image' | 'text'; url?: string; text?: string; taskId: string } | null>(null);
const operatorForm = reactive({ open: false, authUid: '', displayName: '', email: '', role: 'operator', reason: '' });

const visibleNav = computed(() => navItems.filter((item) => !['operators', 'audits'].includes(item.key) || operator.value?.role === 'super_admin'));
const currentNav = computed(() => navItems.find((item) => item.key === activeModule.value) || navItems[0]);

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

async function bootstrap(): Promise<void> {
  try {
    if (!(await hasLoginState())) return;
    const data = await callOps<{ operator: Operator }>('session.me');
    operator.value = data.operator;
    authenticated.value = true;
    await loadModule('dashboard');
  } catch (err) {
    login.error = err instanceof Error ? err.message : '登录状态无效';
    authenticated.value = false;
  } finally {
    booting.value = false;
  }
}

async function submitLogin(): Promise<void> {
  if (!login.email || !login.password || login.loading) return;
  login.loading = true;
  login.error = '';
  try {
    await signIn(login.email.trim(), login.password);
    const data = await callOps<{ operator: Operator }>('session.me');
    operator.value = data.operator;
    authenticated.value = true;
    await loadModule('dashboard');
  } catch (err) {
    login.error = err instanceof Error ? err.message : '登录失败';
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
  activeModule.value = module;
  loading.value = true;
  error.value = '';
  detail.value = null;
  try {
    if (module === 'dashboard') {
      const data = await callOps<{ totals: typeof totals }>('dashboard.summary');
      Object.assign(totals, data.totals);
      rows.value = [];
      nextCursor.value = '';
      hasMore.value = false;
      return;
    }
    const data = await callOps<PageResult>(actionByModule[module], {
      pageSize: 25,
      cursor: append ? nextCursor.value : ''
    });
    rows.value = append ? rows.value.concat(data.items) : data.items;
    nextCursor.value = data.nextCursor;
    hasMore.value = data.hasMore;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '数据加载失败';
  } finally {
    loading.value = false;
  }
}

function openAction(title: string, message: string, action: string, payload: Record<string, unknown>, danger = false, confirmText = '确认'): void {
  Object.assign(dialog, { open: true, title, message, reason: '', action, payload, danger, confirmText });
}

async function confirmAction(): Promise<void> {
  if (!dialog.reason.trim()) return;
  loading.value = true;
  try {
    const payload: Record<string, unknown> = {
      ...dialog.payload,
      reason: dialog.reason.trim()
    };
    if (dialog.action === 'reports.resolve') {
      payload.resolution = dialog.reason.trim();
    }
    await callOps(dialog.action, payload);
    dialog.open = false;
    await loadModule(activeModule.value);
  } catch (err) {
    error.value = err instanceof Error ? err.message : '操作失败';
  } finally {
    loading.value = false;
  }
}

async function viewProtected(row: Row, kind: 'user' | 'family'): Promise<void> {
  const workOrderId = window.prompt(kind === 'user' ? '请输入关联的举报或注销工单 ID' : '请输入关联的举报工单 ID');
  if (!workOrderId) return;
  try {
    detail.value = await callOps<Row>(kind === 'user' ? 'users.detail' : 'families.detail', {
      [kind === 'user' ? 'userId' : 'familyId']: row._id,
      workOrderId: workOrderId.trim()
    });
  } catch (err) {
    error.value = err instanceof Error ? err.message : '详情加载失败';
  }
}

async function previewMedia(row: Row): Promise<void> {
  const reason = window.prompt('请输入复核原因或关联举报工单 ID');
  if (!reason) return;
  try {
    mediaPreview.value = await callOps<{ type: 'image' | 'text'; url?: string; text?: string; taskId: string }>('moderation.getUrl', {
      taskId: row._id,
      reason: reason.trim()
    });
  } catch (err) {
    error.value = err instanceof Error ? err.message : '图片预览失败';
  }
}

async function viewReport(row: Row): Promise<void> {
  const reason = window.prompt('请输入查看举报详情的处理原因');
  if (!reason) return;
  try {
    detail.value = await callOps<Row>('reports.detail', { reportId: row._id, reason: reason.trim() });
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
      role: operatorForm.role,
      reason: operatorForm.reason.trim()
    });
    operatorForm.open = false;
    operatorForm.authUid = '';
    operatorForm.displayName = '';
    operatorForm.email = '';
    operatorForm.reason = '';
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
    <form class="login-card" @submit.prevent="submitLogin">
      <div><p class="eyebrow">运营人员登录</p><h2>欢迎回来</h2><p class="muted">仅限白名单中的 CloudBase 邮箱账号。</p></div>
      <label>邮箱<input v-model="login.email" type="email" autocomplete="username" placeholder="operator@example.com" required /></label>
      <label>密码<input v-model="login.password" type="password" autocomplete="current-password" placeholder="至少 8 位" required /></label>
      <p v-if="login.error" class="form-error">{{ login.error }}</p>
      <button class="primary" :disabled="login.loading">{{ login.loading ? '正在验证...' : '安全登录' }}</button>
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

      <section v-if="activeModule === 'dashboard'" class="dashboard-grid">
        <article><span>活跃用户</span><strong>{{ totals.activeUsers }}</strong><small>当前可用账号</small></article>
        <article><span>活跃家谱</span><strong>{{ totals.activeFamilies }}</strong><small>未归档、未冻结</small></article>
        <article :class="{ attention: totals.reportBacklog > 0 }"><span>举报待办</span><strong>{{ totals.reportBacklog }}</strong><small>待领取或处理中</small></article>
        <article :class="{ attention: totals.moderationBacklog > 0 }"><span>内容复核</span><strong>{{ totals.moderationBacklog }}</strong><small>机器疑似与审核中</small></article>
        <article :class="{ attention: totals.deletionBacklog > 0 }"><span>注销任务</span><strong>{{ totals.deletionBacklog }}</strong><small>待执行或失败</small></article>
        <article class="principle-card"><span>今日原则</span><strong>最小必要访问</strong><small>只因明确工单查看家庭资料，并完整记录原因。</small></article>
      </section>

      <section v-else class="table-card">
        <div v-if="loading && !rows.length" class="loading-state"><div class="spinner"></div><p>正在读取数据...</p></div>
        <div v-else-if="!rows.length" class="empty-state"><div>空</div><h3>当前没有记录</h3><p>新的数据会自动显示在这里。</p></div>
        <div v-else class="table-wrap">
          <table>
            <thead><tr><th>标识 / 名称</th><th>类型 / 角色</th><th>状态</th><th>时间</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="row in rows" :key="row._id">
                <td><strong>{{ row.name || row.nickName || row.displayName || row.identity || row.targetType || row.action || row._id }}</strong><small>{{ row.email || row.reason || row.summary || row.familyId || row._id }}</small></td>
                <td>{{ row.role || row.kind || row.objectType || row.targetType || '—' }}</td>
                <td><span class="status" :class="row.status || row.moderationStatus">{{ statusLabel(row.status || row.moderationStatus) }}</span></td>
                <td>{{ formatDate(row.createdAt || row.requestedAt || row.updatedAt) }}</td>
                <td class="row-actions">
                  <button v-if="activeModule === 'users'" @click="viewProtected(row, 'user')">查看</button>
                  <button v-if="activeModule === 'users' && operator?.role === 'super_admin' && ['active','frozen'].includes(row.status)" :class="{ danger: row.status !== 'frozen' }" @click="openAction(row.status === 'frozen' ? '解除用户冻结' : '冻结用户', '该操作会立即影响用户访问。', 'users.freeze', { userId: row._id, freeze: row.status !== 'frozen' }, row.status !== 'frozen')">{{ row.status === 'frozen' ? '解冻' : '冻结' }}</button>
                  <button v-if="activeModule === 'families'" @click="viewProtected(row, 'family')">查看</button>
                  <button v-if="activeModule === 'families' && operator?.role === 'super_admin' && ['active','archived','frozen'].includes(row.status)" :class="{ danger: row.status !== 'frozen' }" @click="openAction(row.status === 'frozen' ? '解除家谱冻结' : '冻结家谱', '运营人员不能修改家谱内容，只能控制访问状态。', 'families.freeze', { familyId: row._id, freeze: row.status !== 'frozen' }, row.status !== 'frozen')">{{ row.status === 'frozen' ? '解冻' : '冻结' }}</button>
                  <button v-if="activeModule === 'reports' && row.status === 'open'" @click="openAction('领取举报工单', '领取后工单将进入处理中。', 'reports.assign', { reportId: row._id })">领取</button>
                  <button v-if="activeModule === 'reports'" @click="viewReport(row)">详情</button>
                  <button v-if="activeModule === 'reports' && ['open','processing'].includes(row.status)" @click="openAction('解决举报', '填写处理结论，用户将看到工单已完成。', 'reports.resolve', { reportId: row._id, decision: 'resolve', resolution: '' })">解决</button>
                  <button v-if="activeModule === 'reports' && ['open','processing'].includes(row.status)" @click="openAction('驳回举报', '确认举报不成立并填写理由。', 'reports.resolve', { reportId: row._id, decision: 'reject', resolution: '' }, true, '驳回')">驳回</button>
                  <button v-if="activeModule === 'moderation'" @click="previewMedia(row)">受控预览</button>
                  <button v-if="activeModule === 'moderation'" @click="openAction('通过内容', '确认内容符合产品规范。', 'moderation.review', { taskId: row._id, decision: 'approve' })">通过</button>
                  <button v-if="activeModule === 'moderation'" class="danger" @click="openAction('拒绝内容', '拒绝后内容不会向家庭成员展示。', 'moderation.review', { taskId: row._id, decision: 'reject' }, true, '拒绝')">拒绝</button>
                  <button v-if="activeModule === 'deletions' && row.status === 'failed' && operator?.role === 'super_admin'" @click="openAction('重试注销', '任务会由后台维护函数重新执行。', 'deletions.retry', { deletionId: row._id }, true, '重试')">重试</button>
                  <button v-if="activeModule === 'operators' && row.status === 'active'" class="danger" @click="openAction('停用运营账号', '该账号将立即失去运营后台访问权限。', 'operators.disable', { operatorId: row._id }, true, '停用')">停用</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <button v-if="hasMore" class="load-more" :disabled="loading" @click="loadModule(activeModule, true)">{{ loading ? '加载中...' : '加载更多' }}</button>
      </section>

      <section v-if="detail" class="detail-drawer"><button class="drawer-close" @click="detail = null">×</button><p class="eyebrow">受控详情</p><h2>必要资料查看结果</h2><pre>{{ JSON.stringify(detail, null, 2) }}</pre></section>
    </main>

    <div v-if="dialog.open" class="modal-mask" @click.self="dialog.open = false"><section class="modal"><p class="eyebrow">二次确认</p><h2>{{ dialog.title }}</h2><p>{{ dialog.message }}</p><label>操作原因<textarea v-model="dialog.reason" maxlength="200" placeholder="必须填写工单号或明确原因"></textarea></label><div class="modal-actions"><button class="secondary" @click="dialog.open = false">取消</button><button :class="dialog.danger ? 'danger-button' : 'primary'" :disabled="!dialog.reason.trim()" @click="confirmAction">{{ dialog.confirmText }}</button></div></section></div>

    <div v-if="mediaPreview" class="modal-mask" @click.self="mediaPreview = null"><section class="modal media-modal"><p class="eyebrow">受控内容预览</p><h2>待复核{{ mediaPreview.type === 'text' ? '文字' : '图片' }}</h2><img v-if="mediaPreview.type === 'image'" :src="mediaPreview.url" alt="待复核家庭图片" /><pre v-else class="moderation-text">{{ mediaPreview.text }}</pre><p class="muted">内容仅用于当前复核，不会写入操作日志。</p><div class="modal-actions"><button class="secondary" @click="mediaPreview = null">关闭</button></div></section></div>

    <div v-if="operatorForm.open" class="modal-mask" @click.self="operatorForm.open = false"><section class="modal"><p class="eyebrow">运营白名单</p><h2>新增运营账号</h2><label>CloudBase Auth UID<input v-model="operatorForm.authUid" /></label><label>姓名<input v-model="operatorForm.displayName" /></label><label>邮箱<input v-model="operatorForm.email" type="email" /></label><label>角色<select v-model="operatorForm.role"><option value="operator">运营人员</option><option value="super_admin">超级管理员</option></select></label><label>创建原因<textarea v-model="operatorForm.reason" maxlength="200" placeholder="填写工单或授权说明"></textarea></label><div class="modal-actions"><button class="secondary" @click="operatorForm.open = false">取消</button><button class="primary" :disabled="!operatorForm.authUid || !operatorForm.displayName || !operatorForm.reason.trim()" @click="createOperator">创建账号</button></div></section></div>
  </div>
</template>
