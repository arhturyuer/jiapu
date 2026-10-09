<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { callOps, getErrorMessage } from '../cloudbase';

const props = defineProps<{ isSuperAdmin: boolean }>();
interface Row {
  _id: string; recordId?: string; recordType?: 'payment' | 'redemption'; orderId?: string;
  familyId?: string; familyName?: string; productId: string; productName: string;
  priceCents?: number | null; status: string; createdAt: string; redeemedAt?: string;
  expiresAt?: string | null; batchId?: string; note?: string; maskedCode?: string;
  redeemedFamilyId?: string; reconcileStatus?: string; code?: string;
  startsAt?: string; endsAt?: string | null; lifetime?: boolean;
}
interface PageResult { items: Row[]; nextCursor: string; hasMore: boolean }
const tab = ref<'records' | 'codes'>('records');
const rows = ref<Row[]>([]); const busy = ref(false); const error = ref(''); const notice = ref('');
const cursors = ref(['']); const page = ref(0); const nextCursor = ref(''); const hasMore = ref(false);
const filters = reactive({ recordType: 'all', batchId: '', productId: '', status: '' });
const form = reactive({ productId: 'youpu_vip_365d', quantity: 1, expiresAt: '', note: '' });
const generating = ref(false); const generated = ref<Row[]>([]); const generatedBatch = ref('');
const revealed = reactive<Record<string, string>>({}); const detail = ref<Row | null>(null);
const products = [['youpu_vip_30d', '30 天'], ['youpu_vip_365d', '1 年'], ['youpu_vip_life', '永久']];
let generationRequest: { fingerprint: string; requestId: string } | null = null;
let sequence = 0;
function requestId(): string { return `${Date.now().toString(36)}-${crypto.randomUUID()}`; }
function date(value?: string | null): string { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'; }
function status(row: Row): string {
  if (row.recordType === 'redemption') return '已兑换';
  return ({ unused: '未使用', redeemed: '已兑换', expired: '已过期', revoked: '已作废', pending: '待确认', fulfilled: '已开通', refunded: '已退款', closed: '已关闭', failed: '未完成' } as Record<string, string>)[row.status] || row.status;
}
async function load(reset = true): Promise<void> {
  const current = ++sequence;
  if (reset) { page.value = 0; cursors.value = ['']; }
  busy.value = true; error.value = ''; rows.value = []; detail.value = null;
  try {
    const params = tab.value === 'records' ? { recordType: filters.recordType } : { batchId: filters.batchId.trim(), productId: filters.productId, status: filters.status };
    const result = await callOps<PageResult>(tab.value === 'records' ? 'commerce.records' : 'commerce.codes.list', { ...params, pageSize: 25, cursor: cursors.value[page.value] || '' });
    if (current !== sequence) return;
    rows.value = result.items; nextCursor.value = result.nextCursor; hasMore.value = result.hasMore;
  } catch (err) { if (current === sequence) error.value = getErrorMessage(err, '读取失败，请重试'); }
  finally { if (current === sequence) busy.value = false; }
}
function switchTab(value: 'records' | 'codes'): void { tab.value = value; notice.value = ''; void load(); }
async function navigate(direction: number): Promise<void> {
  if (busy.value) return;
  if (direction > 0) cursors.value[page.value + 1] = nextCursor.value;
  page.value += direction; await load(false);
}
async function generate(): Promise<void> {
  if (!props.isSuperAdmin || generating.value) return;
  let expiresAt: string | null = null;
  if (form.expiresAt) {
    // datetime-local is explicitly interpreted as Beijing time, independent of the operator's device timezone.
    const parsed = new Date(form.expiresAt + ':00+08:00');
    if (!Number.isFinite(parsed.getTime())) { error.value = '兑换截止时间无效'; return; }
    expiresAt = parsed.toISOString();
  }
  const params = { productId: form.productId, quantity: Number(form.quantity), expiresAt, note: form.note };
  const fingerprint = JSON.stringify(params);
  if (!generationRequest || generationRequest.fingerprint !== fingerprint) generationRequest = { fingerprint, requestId: requestId() };
  generating.value = true; error.value = ''; notice.value = ''; generated.value = []; generatedBatch.value = '';
  try {
    const result = await callOps<{ batchId: string; quantity: number }>('commerce.codes.generate', { ...params, requestId: generationRequest.requestId });
    generatedBatch.value = result.batchId;
    generationRequest = null;
    notice.value = `已生成 ${result.quantity} 个兑换码，批次 ${result.batchId}`;
    filters.batchId = result.batchId; filters.productId = ''; filters.status = '';
    await revealBatch(result.batchId); await load();
  } catch (err) { error.value = generatedBatch.value ? '生成已成功，可按批次再次查看完整码。' + getErrorMessage(err, '读取失败') : getErrorMessage(err, '生成结果暂未确认，请保留参数并重试'); }
  finally { generating.value = false; }
}
async function revealBatch(batchId: string): Promise<void> {
  const result = await callOps<{ items: Row[] }>('commerce.codes.reveal', { batchId });
  generated.value = result.items; generatedBatch.value = batchId;
}
async function showBatch(): Promise<void> {
  if (!props.isSuperAdmin || !filters.batchId.trim()) return;
  try { await revealBatch(filters.batchId.trim()); } catch (err) { error.value = getErrorMessage(err, '批次读取失败'); }
}
async function copy(value: string): Promise<void> {
  try { await navigator.clipboard.writeText(value); notice.value = '已复制'; }
  catch { error.value = '复制失败，请选择显示的兑换码手动复制'; }
}
async function reveal(row: Row): Promise<void> {
  try {
    const result = await callOps<{ items: Row[] }>('commerce.codes.reveal', { codeId: row._id });
    revealed[row._id] = result.items[0].code || '';
  } catch (err) { error.value = getErrorMessage(err, '读取失败'); }
}
function download(): void {
  const quote = (value: unknown) => '"' + String(value ?? '').replace(/"/g, '""') + '"';
  const content = [['兑换码', '套餐', '状态', '兑换截止时间', '批次'], ...generated.value.map(row => [row.code, row.productName, status(row), row.expiresAt ? date(row.expiresAt) : '长期有效', row.batchId])];
  const url = URL.createObjectURL(new Blob(['\uFEFF' + content.map(row => row.map(quote).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `${generatedBatch.value}.csv`; link.click(); URL.revokeObjectURL(url);
}
async function revoke(row: Row): Promise<void> {
  if (!props.isSuperAdmin || !confirm('确认作废此兑换码？作废后不能兑换。')) return;
  busy.value = true;
  try { await callOps('commerce.codes.revoke', { codeId: row._id }); notice.value = '兑换码已作废'; await load(false); }
  catch (err) { error.value = getErrorMessage(err, '作废失败'); }
  finally { busy.value = false; }
}
async function openDetail(row: Row): Promise<void> {
  try { detail.value = await callOps<Row>('commerce.recordDetail', { recordType: row.recordType, recordId: row._id }); }
  catch (err) { error.value = getErrorMessage(err, '记录读取失败'); }
}
async function retryOrder(row: Row): Promise<void> {
  if (!confirm('请求后台重新向微信查单？')) return;
  try { await callOps('commerce.retryOrder', { orderId: row._id }); notice.value = '已请求查单'; await load(false); }
  catch (err) { error.value = getErrorMessage(err, '查单请求失败'); }
}
onMounted(() => { void load(); });
</script>

<template>
  <div class="table-card membership-manager">
    <div class="moderation-tabs" role="tablist" aria-label="会员管理">
      <button :class="{ active: tab === 'records' }" :aria-selected="tab === 'records'" role="tab" @click="switchTab('records')">会员记录</button>
      <button :class="{ active: tab === 'codes' }" :aria-selected="tab === 'codes'" role="tab" @click="switchTab('codes')">兑换码</button>
    </div>
    <p v-if="error" class="membership-error" role="alert">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <div v-if="tab === 'records'" class="membership-filters">
      <label>记录类型 <select v-model="filters.recordType" :disabled="busy" @change="load()"><option value="all">全部</option><option value="payment">付费购买</option><option value="redemption">兑换码兑换</option></select></label>
      <button :disabled="busy" @click="load(false)">刷新记录</button>
    </div>
    <template v-else>
      <form v-if="isSuperAdmin" class="membership-form" @submit.prevent="generate">
        <h3>生成兑换码</h3>
        <label>会员套餐 <select v-model="form.productId" :disabled="generating"><option v-for="product in products" :key="product[0]" :value="product[0]">{{ product[1] }}</option></select></label>
        <label>数量 <input v-model.number="form.quantity" :disabled="generating" type="number" min="1" max="50" required></label>
        <label>兑换截止时间（北京时间，留空为长期有效） <input v-model="form.expiresAt" :disabled="generating" type="datetime-local"></label>
        <label>批次备注 <input v-model="form.note" :disabled="generating" maxlength="100"></label>
        <button type="submit" :disabled="generating">{{ generating ? '正在生成…' : '生成兑换码' }}</button>
      </form>
      <div class="membership-filters">
        <label>批次 <input v-model="filters.batchId" placeholder="批次编号" :disabled="busy"></label>
        <label>套餐 <select v-model="filters.productId" :disabled="busy"><option value="">全部</option><option v-for="product in products" :key="product[0]" :value="product[0]">{{ product[1] }}</option></select></label>
        <label>状态 <select v-model="filters.status" :disabled="busy"><option value="">全部</option><option value="unused">未使用</option><option value="redeemed">已兑换</option><option value="expired">已过期</option><option value="revoked">已作废</option></select></label>
        <button :disabled="busy" @click="load()">查询</button><button v-if="isSuperAdmin" :disabled="!filters.batchId.trim() || busy" @click="showBatch">查看完整批次</button>
      </div>
      <div v-if="isSuperAdmin && generated.length" class="membership-batch">
        <strong>{{ generatedBatch }}</strong><textarea readonly :value="generated.map(row => row.code).join('\n')" aria-label="本批完整兑换码"></textarea>
        <button @click="copy(generated.map(row => row.code).join('\n'))">复制整批</button><button @click="download">下载 CSV</button>
      </div>
    </template>
    <p v-if="busy">正在读取…</p><p v-else-if="!rows.length">暂无记录</p>
    <div v-else class="table-wrap"><table>
      <thead v-if="tab === 'records'"><tr><th>记录 / 家谱</th><th>类型</th><th>套餐</th><th>金额</th><th>状态</th><th>时间</th><th>操作</th></tr></thead>
      <thead v-else><tr><th>兑换码 / 批次</th><th>套餐</th><th>状态</th><th>截止时间</th><th>兑换信息</th><th>操作</th></tr></thead>
      <tbody><tr v-for="row in rows" :key="row.recordId || row._id">
        <template v-if="tab === 'records'">
          <td><strong>{{ row._id }}</strong><small>{{ row.familyName || row.familyId }}</small></td><td>{{ row.recordType === 'redemption' ? '兑换码兑换' : '付费购买' }}</td>
          <td>{{ row.productName }}</td><td>{{ row.recordType === 'redemption' ? '—' : `¥${(Number(row.priceCents || 0) / 100).toFixed(2)}` }}</td><td>{{ status(row) }}</td>
          <td>{{ date(row.redeemedAt || row.createdAt) }}</td><td class="row-actions"><button @click="openDetail(row)">详情</button><button v-if="row.recordType === 'payment' && row.status === 'pending'" @click="retryOrder(row)">查单重试</button></td>
        </template>
        <template v-else>
          <td><strong>{{ isSuperAdmin && revealed[row._id] ? revealed[row._id] : row.maskedCode }}</strong><small>{{ row.batchId }}</small><small>{{ row.note }}</small></td><td>{{ row.productName }}</td><td>{{ status(row) }}</td><td>{{ row.expiresAt ? date(row.expiresAt) : '长期有效' }}</td>
          <td><strong>{{ row.redeemedFamilyId || '—' }}</strong><small>{{ date(row.redeemedAt) }}</small></td>
          <td class="row-actions"><template v-if="isSuperAdmin"><button @click="reveal(row)">查看完整码</button><button v-if="revealed[row._id]" @click="copy(revealed[row._id])">复制</button><button v-if="['unused', 'expired'].includes(row.status)" :disabled="busy" @click="revoke(row)">作废</button></template><span v-else>只读</span></td>
        </template>
      </tr></tbody>
    </table></div>
    <div class="pagination"><span>第 {{ page + 1 }} 页</span><div><button :disabled="busy || !page" @click="navigate(-1)">上一页</button><button :disabled="busy || !hasMore" @click="navigate(1)">下一页</button><button v-if="error" :disabled="busy" @click="load(false)">重试</button></div></div>
    <div v-if="detail" class="membership-detail"><button @click="detail = null">关闭详情</button><h3>{{ detail.productName }}</h3><p>{{ detail.recordType === 'redemption' ? '兑换码兑换' : '付费购买' }} · {{ status(detail) }}</p><p>家谱：{{ detail.familyName || detail.familyId }}</p><p>记录：{{ detail._id }}</p><p v-if="detail.recordType === 'redemption'">兑换码：{{ detail.maskedCode }}<br>兑换时间：{{ date(detail.redeemedAt) }}<br>权益：{{ detail.lifetime ? '永久有效' : `${date(detail.startsAt)} 至 ${date(detail.endsAt)}` }}</p></div>
  </div>
</template>

<style scoped>
.membership-manager { padding:24px; }
.membership-manager button { border:1px solid #ccd8cf; border-radius:10px; background:#f6f8f4; padding:10px 14px; color:#245c4a; cursor:pointer; font:inherit; font-weight:600; }
.membership-manager button:hover { background:#eaf1e9; }
.membership-manager button:disabled { opacity:.5; cursor:default; }
.membership-form button[type=submit],.membership-manager .moderation-tabs button.active { background:#245c4a; border-color:#245c4a; color:#fff; }
.membership-form,.membership-filters { display:flex; align-items:end; flex-wrap:wrap; gap:16px; padding:16px 0; }
.membership-form { border-bottom:1px solid #dce6db; margin-bottom:16px; }
.membership-form h3 { flex-basis:100%; margin:0; }
label { display:flex; flex-direction:column; gap:8px; font-size:14px; }
input,select,textarea { border:1px solid #ccd8cf; border-radius:8px; padding:10px; font:inherit; background:#fff; }
.membership-error { color:#9d3535; overflow-wrap:anywhere; }
.membership-batch { padding:16px; background:#f1f7f3; border-radius:12px; }
textarea { display:block; width:100%; min-height:160px; margin:12px 0; box-sizing:border-box; }
.membership-batch button { margin-right:12px; }
.membership-detail { margin-top:20px; padding:20px; border:1px solid #dce6db; border-radius:12px; overflow-wrap:anywhere; }
</style>
