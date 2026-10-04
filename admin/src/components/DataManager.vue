<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { callOps, getErrorMessage } from '../cloudbase';
type Value = number | null;
interface DailyRow { [key: string]: Value | string | boolean; day: string; partial: boolean; activityComplete: boolean; mature: boolean }
interface Filters { startDay: string; endDay: string; window: string; paymentMode: string }
interface Report {
  snapshotId: string; rows: DailyRow[]; totals: Record<string, Value>;
  sku: Array<{ productId: string; name: string; orders: number; gmvCents: number }>;
  filters: Filters; trackingStartedAt: string; asOf: string; generatedAt: string; activityComplete: boolean;
}
interface Column { key: string; label: string; format?: 'money' | 'rate'; numerator?: string; denominator?: string }
interface DetailItem {
  _id: string; kind: string; cleaned: boolean; createdAt?: string; firstEnteredFamilyAt?: string; firstExampleViewedAt?: string;
  firstCreatedFamilyAt?: string; firstJoinedFamilyAt?: string; creatorId?: string; firstRelativeJoinedAt?: string;
  relativeCount?: number; activeRelativeCount?: number; status?: string; productName?: string; priceCents?: number;
  paymentMode?: string; paidAt?: string; refundedAt?: string;
}
interface DetailPage { items: DetailItem[]; total: number; hasMore: boolean; nextCursor: string; asOf: string }
const props = defineProps<{ refreshKey: number }>();
const emit = defineEmits<{ loading: [value: boolean]; 'view-user': [row: { _id: string }]; 'view-family': [row: { _id: string }]; 'view-order': [row: { _id: string }] }>();
const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const shift = (value: string, days: number) => new Date(Date.parse(value + 'T00:00:00+08:00') + days * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
const startDay = ref(today()); const endDay = ref(today()); const window = ref('day'); const paymentMode = ref('live');
const loading = ref(false); const error = ref(''); const report = ref<Report | null>(null); const trendReport = ref<Report | null>(null);
const trendError = ref('');
const tab = ref('growth'); const metric = ref('newUsers'); const sortDescending = ref(true);
let requestVersion = 0;
const growth: Column[] = [
  { key: 'newUsers', label: '新用户' },
  { key: 'exampleRate', label: '示例体验率', format: 'rate', numerator: 'exampleUsers', denominator: 'newUsers' },
  { key: 'enterRate', label: '进入真实家谱转化率', format: 'rate', numerator: 'enteredUsers', denominator: 'newUsers' },
  { key: 'createRate', label: '创建家谱转化率', format: 'rate', numerator: 'createdUsers', denominator: 'newUsers' },
  { key: 'joinRate', label: '加入家谱转化率', format: 'rate', numerator: 'joinedUsers', denominator: 'newUsers' }
];
const familyGrowth: Column[] = [
  { key: 'newFamilies', label: '新建家谱' },
  { key: 'relativeRate', label: '曾有家人加入比例', format: 'rate', numerator: 'familiesWithRelatives', denominator: 'newFamilies' },
  { key: 'collaborationRate', label: '当前协作比例', format: 'rate', numerator: 'collaborativeFamilies', denominator: 'newFamilies' }
];
const activity: Column[] = [{ key: 'dau', label: '每日活跃用户' }, { key: 'activeFamilies', label: '每日活跃家谱' }];
const payment: Column[] = [
  { key: 'orders', label: '创建订单' }, { key: 'paymentRate', label: '订单支付转化率', format: 'rate', numerator: 'convertedOrders', denominator: 'orders' },
  { key: 'paidOrders', label: '成功支付订单' }, { key: 'payingUsers', label: '付费用户' }, { key: 'payingFamilies', label: '付费家谱' },
  { key: 'gmvCents', label: '支付金额', format: 'money' }, { key: 'refundOrders', label: '退款订单' }, { key: 'refundCents', label: '退款金额', format: 'money' },
  { key: 'netCents', label: '净收款', format: 'money' }, { key: 'aovCents', label: '客单价', format: 'money' }, { key: 'arppuCents', label: 'ARPPU', format: 'money' }
];
const tabs = [['growth', '用户增长'], ['families', '家谱增长'], ['activity', '活跃'], ['payment', '付费']];
const columns = computed(() => tab.value === 'growth' ? growth : tab.value === 'families' ? familyGrowth : tab.value === 'activity' ? activity : payment);
const metricOptions = [...growth, ...familyGrowth, ...activity, ...payment];
const selectedMetric = computed(() => metricOptions.find(item => item.key === metric.value) || growth[0]);
const displayRows = computed(() => sortDescending.value ? [...(report.value?.rows || [])].reverse() : report.value?.rows || []);
const dirty = computed(() => report.value && (startDay.value !== report.value.filters.startDay || endDay.value !== report.value.filters.endDay || window.value !== report.value.filters.window || paymentMode.value !== report.value.filters.paymentMode));
const modes: Record<string, string> = { live: '真实支付', sandbox: '微信沙箱', mock: '模拟支付', all: '全部支付环境' };
const windows: Record<string, string> = { day: '当天', '7d': '7 天内', '30d': '30 天内' };
function numberValue(row: DailyRow, key: string): Value { return typeof row[key] === 'number' ? row[key] as number : null; }
function format(value: Value | undefined, kind?: string) {
  if (value === null || value === undefined) return '—';
  if (kind === 'money') return (value / 100).toLocaleString('zh-CN', { style: 'currency', currency: 'CNY' });
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + (kind === 'rate' ? '%' : '');
}
const cards = computed<Array<Column & { value: Value | undefined; hint: string }>>(() => {
  const totals = report.value?.totals || {};
  if (tab.value === 'activity') return [
    { key: 'activeUsers', label: report.value?.filters.startDay === report.value?.filters.endDay ? '每日活跃用户' : '期间去重活跃用户', value: totals.activeUsers, hint: `日均 ${format(totals.averageDau)} 人` },
    { key: 'activeFamilies', label: report.value?.filters.startDay === report.value?.filters.endDay ? '每日活跃家谱' : '期间去重活跃家谱', value: totals.activeFamilies, hint: `日均 ${format(totals.averageActiveFamilies)} 份` }
  ];
  const items: Column[] = [...columns.value, ...(tab.value === 'payment' ? [{ key: 'activeMemberFamilies', label: '当前有效会员家谱' }] : [])];
  return items.map(column => ({ ...column, value: totals[column.key], hint: column.numerator ? `${format(totals[column.numerator])} / ${format(totals[column.denominator!])}` : column.key === 'activeMemberFamilies' ? '查询时点 · 所有支付环境' : column.key === 'netCents' ? '未扣平台费用' : '选定期间' }));
});
const chart = computed(() => {
  const rows = trendReport.value?.rows || [];
  const values = rows.map(row => numberValue(row, metric.value));
  const valid = values.filter((value): value is number => typeof value === 'number');
  const min = Math.min(0, ...valid); const max = Math.max(1, ...valid);
  const points = rows.map((row, index) => ({ row, value: values[index], x: 100 + index / Math.max(1, rows.length - 1) * 860, y: 240 - ((values[index] || 0) - min) / (max - min) * 200 }));
  const segments: string[] = []; let current: string[] = [];
  points.forEach(point => {
    if (point.value === null) { if (current.length) segments.push(current.join(' ')); current = []; }
    else current.push(`${point.x},${point.y}`);
  });
  if (current.length) segments.push(current.join(' '));
  return { points, segments, hasData: valid.length > 0, ticks: [min, min + (max - min) / 2, max].map(value => ({ value, y: 240 - (value - min) / (max - min) * 200 })) };
});
async function load() {
  const version = ++requestVersion; loading.value = true; emit('loading', true); error.value = ''; trendError.value = ''; closeDetails();
  const filters = { startDay: startDay.value, endDay: endDay.value, window: window.value, paymentMode: paymentMode.value };
  try {
    const data = await callOps<Report>('analytics.summary', filters);
    if (version !== requestVersion) return;
    report.value = data;
    trendReport.value = data;
    if (filters.startDay === filters.endDay) {
      try { const trend = await callOps<Report>('analytics.summary', { ...filters, startDay: shift(filters.endDay, -29) }); if (version === requestVersion) trendReport.value = trend; }
      catch (err) { if (version === requestVersion) trendError.value = getErrorMessage(err, '近 30 天趋势暂不可用'); }
    }
  } catch (err) { if (version === requestVersion) error.value = getErrorMessage(err, '数据读取失败，请重试'); }
  finally { if (version === requestVersion) { loading.value = false; emit('loading', false); } }
}
function preset(days: number, yesterday = false) { endDay.value = shift(today(), yesterday ? -1 : 0); startDay.value = shift(endDay.value, 1 - days); void load(); }
function switchTab(value: string) { tab.value = value; metric.value = columns.value[0].key; }
function exportCsv() {
  if (!report.value || loading.value || error.value || dirty.value) return;
  const data = report.value;
  const fields: Column[] = [...growth, ...familyGrowth, ...activity, ...payment,
    { key: 'exampleUsers', label: '体验示例新用户数' }, { key: 'enteredUsers', label: '进入真实家谱新用户数' },
    { key: 'createdUsers', label: '创建家谱新用户数' }, { key: 'joinedUsers', label: '加入家谱新用户数' },
    { key: 'familiesWithRelatives', label: '曾有家人加入新家谱数' }, { key: 'collaborativeFamilies', label: '当前协作新家谱数' }];
  const lines: Array<Array<string | number>> = [
    ['时区', '北京时间'], ['日期范围', data.filters.startDay, data.filters.endDay], ['转化窗口', windows[data.filters.window]],
    ['支付筛选', modes[data.filters.paymentMode]], ['统计截止', data.asOf], ['采集开始', data.trackingStartedAt],
    ['口径', '首次建档日队列；窗口含起始自然日；收入按支付日、退款按退款日；当前协作为查询时点有效成员'],
    ['历史边界', '访问不可追溯补造；历史创建加入由现存及保留记录补充'],
    ['日期', '当日未结束', '完整采集', '转化窗口完整', ...fields.map(field => field.label + (field.format === 'money' ? '（元）' : field.format === 'rate' ? '（%）' : ''))],
    ...data.rows.map(row => [row.day, row.partial ? '是' : '否', row.activityComplete ? '是' : '否', row.mature ? '是' : '否',
      ...fields.map(field => numberValue(row, field.key) === null ? '' : field.format === 'money' ? Number(row[field.key]) / 100 : Number(row[field.key]))])
  ];
  const csv = '\uFEFF' + lines.map(line => line.map(value => '"' + String(value).replace(/"/g, '""') + '"').join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `有谱数据-${data.filters.startDay}-${data.filters.endDay}-${data.filters.paymentMode}.csv`; link.click(); URL.revokeObjectURL(url);
}
const detailMetric = ref(''); const detailLabel = ref(''); const detailPage = ref<DetailPage | null>(null);
const detailDay = ref('');
const detailLoading = ref(false); const detailError = ref(''); const detailCursors = ref(['']); const detailIndex = ref(0);
let detailVersion = 0;
const metricMap: Record<string, string> = { enterRate: 'enteredUsers', exampleRate: 'exampleUsers', createRate: 'createdUsers', joinRate: 'joinedUsers', relativeRate: 'familiesWithRelatives', collaborationRate: 'collaborativeFamilies', paymentRate: 'convertedOrders', dau: 'activeUsers', gmvCents: 'paidOrders', refundCents: 'refundOrders', aovCents: 'paidOrders', arppuCents: 'payingUsers' };
function closeDetails() { detailVersion += 1; detailMetric.value = ''; detailPage.value = null; detailLoading.value = false; detailError.value = ''; }
function canDrill(key: string) { return key !== 'netCents'; }
async function openDetails(key: string, label: string, value: Value | undefined, date = '') {
  if (value === null || value === undefined || loading.value || dirty.value || error.value || !report.value || !canDrill(key)) return;
  detailMetric.value = metricMap[key] || key; detailDay.value = date; detailLabel.value = (date ? date + ' · ' : '') + label; detailIndex.value = 0; detailCursors.value = ['']; detailPage.value = null; await loadDetails();
}
async function loadDetails() {
  if (!report.value || !detailMetric.value) return;
  const version = ++detailVersion; detailLoading.value = true; detailError.value = ''; detailPage.value = null;
  try {
    const data = await callOps<DetailPage>('analytics.details', { ...report.value.filters, day: detailDay.value || undefined, metric: detailMetric.value, snapshotId: report.value.snapshotId, pageSize: 20, cursor: detailCursors.value[detailIndex.value] });
    if (version === detailVersion) { detailPage.value = data; detailCursors.value[detailIndex.value + 1] = data.nextCursor; }
  } catch (err) { if (version === detailVersion) detailError.value = getErrorMessage(err, '明细读取失败，请重试'); }
  finally { if (version === detailVersion) detailLoading.value = false; }
}
function turnDetails(direction: number) { detailIndex.value += direction; void loadDetails(); }
function viewRecord(item: DetailItem) { if (item.kind === 'user') emit('view-user', item); else if (item.kind === 'family') emit('view-family', item); else emit('view-order', item); }
function dateLabel(value?: string) { return value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '—'; }
watch([startDay, endDay, window, paymentMode], closeDetails);
watch(() => props.refreshKey, load);
onMounted(load);
onBeforeUnmount(() => { requestVersion += 1; closeDetails(); emit('loading', false); });
</script>

<template>
  <section class="data-manager" :aria-busy="loading">
    <form class="data-filters" @submit.prevent="load">
      <div class="data-presets" aria-label="快捷日期"><button type="button" :disabled="loading" @click="preset(1)">今天</button><button type="button" :disabled="loading" @click="preset(1, true)">昨天</button><button v-for="days in [7, 30, 90]" :key="days" type="button" :disabled="loading" @click="preset(days)">近 {{ days }} 天</button></div>
      <div class="data-filter-fields"><label>开始日期<input v-model="startDay" type="date" :max="endDay" required /></label><label>结束日期<input v-model="endDay" type="date" :min="startDay" :max="today()" required /></label><label>转化观察窗口<select v-model="window"><option v-for="(label, value) in windows" :key="value" :value="value">{{ label }}</option></select></label><label>付费环境<select v-model="paymentMode"><option v-for="(label, value) in modes" :key="value" :value="value">{{ label }}</option></select></label><button class="primary compact" :disabled="loading">{{ loading ? '查询中…' : '查询数据' }}</button><button type="button" class="secondary compact" :disabled="!report || loading || !!error || !!dirty" @click="exportCsv">导出每日 CSV</button></div>
      <small>北京时间 · 最多 90 天 · 今日截至查询时点，刷新获取最新数据（最多 30 秒延迟）</small>
    </form>
    <p v-if="error" class="alert" role="alert">{{ error }} <button :disabled="loading" @click="load">重新加载</button></p>
    <p v-if="dirty && report" class="alert" role="status">筛选已修改，下方显示上次查询结果，请点击“查询数据”。</p>
    <div v-if="loading && !report" class="loading-state"><div class="spinner"></div><p>正在汇总增长、活跃与付费数据…</p></div>
    <template v-if="report">
      <div class="data-report-meta"><strong>{{ report.filters.startDay }} 至 {{ report.filters.endDay }}</strong><span>{{ windows[report.filters.window] }}转化 · {{ modes[report.filters.paymentMode] }}</span><small>统计截止 {{ dateLabel(report.asOf) }}<template v-if="report.rows.some(row => row.partial)"> · 当日未结束</template></small></div>
      <p v-if="!report.activityComplete" class="data-quality" role="status">{{ report.trackingStartedAt ? '访问采集开始于 ' + dateLabel(report.trackingStartedAt) : '尚未启用访问采集' }}。缺失日期的活跃、示例及进入转化显示“—”，表示未完整采集。创建和加入的历史可能缺少已清理记录。</p>
      <div class="moderation-tabs" role="tablist" aria-label="数据分类"><button v-for="item in tabs" :key="item[0]" role="tab" :class="{ active: tab === item[0] }" :aria-selected="tab === item[0]" @click="switchTab(item[0])">{{ item[1] }}</button></div>
      <p v-if="tab === 'growth'" class="data-quality">转化率只统计所选日期内建档的新用户。分子为这些新用户在观察窗口内完成对应行为的人数，分母为这些新用户人数；老用户今天浏览或建谱，不计入今天的新用户转化。点击「新用户」可核对建档及首次行为时间。</p>
      <div class="data-kpis"><article v-for="card in cards" :key="card.key"><span>{{ card.label }}</span><button class="data-metric" :disabled="card.value == null || !canDrill(card.key) || loading || !!dirty || !!error" @click="openDetails(card.key, card.label, card.value)">{{ format(card.value, card.format) }}</button><small>{{ card.hint }}<template v-if="canDrill(card.key) && card.value != null"> · 查看明细 →</template></small></article></div>
      <section v-if="detailMetric" class="table-card data-detail" aria-label="指标明细">
        <div class="data-table-heading"><div><h2>{{ detailLabel }}明细</h2><small>对应查询快照<template v-if="detailPage"> · {{ detailPage.total }} 条 · 截至 {{ dateLabel(detailPage.asOf) }}</template></small></div><button class="secondary compact" @click="closeDetails">关闭明细</button></div>
        <p v-if="detailError" class="alert">{{ detailError }} <button @click="loadDetails">重试</button></p><p v-if="detailLoading" class="data-quality">正在读取明细…</p>
        <div v-if="detailPage" class="table-wrap"><table><thead><tr><th>记录</th><th>首次建档 / 创建</th><th>转化与协作 / 订单</th><th>操作</th></tr></thead><tbody><tr v-for="item in detailPage.items" :key="item._id"><td><strong>{{ item._id }}</strong><small>{{ item.cleaned ? '记录已清理，保留历史统计' : item.status || '访问记录' }}</small></td><td>{{ dateLabel(item.createdAt) }}</td><td><template v-if="item.kind === 'user'"><small>示例 {{ dateLabel(item.firstExampleViewedAt) }}</small><small>真实家谱 {{ dateLabel(item.firstEnteredFamilyAt) }}</small><small>创建 {{ dateLabel(item.firstCreatedFamilyAt) }} · 加入 {{ dateLabel(item.firstJoinedFamilyAt) }}</small></template><template v-else-if="item.kind === 'family'"><small>创建者 {{ item.creatorId || '—' }}</small><small>首次家人加入 {{ dateLabel(item.firstRelativeJoinedAt) }}</small><small>曾加入 {{ item.relativeCount ?? '—' }} 人 · 当前有效 {{ item.activeRelativeCount ?? '—' }} 人</small></template><template v-else><strong>{{ item.productName }}</strong><small>{{ format(item.priceCents, 'money') }} · {{ modes[item.paymentMode || ''] || '环境未知' }}</small><small>支付 {{ dateLabel(item.paidAt) }} · 退款 {{ dateLabel(item.refundedAt) }}</small></template></td><td><button :disabled="item.cleaned || detailLoading" @click="viewRecord(item)">查看{{ item.kind === 'user' ? '用户' : item.kind === 'family' ? '家谱' : '订单' }}详情</button></td></tr></tbody></table><p v-if="!detailPage.items.length" class="data-quality">当前指标没有对应记录。</p></div>
        <div v-if="detailPage" class="pagination"><span>第 {{ detailIndex + 1 }} 页</span><div><button :disabled="detailLoading || detailIndex === 0" @click="turnDetails(-1)">上一页</button><button :disabled="detailLoading || !detailPage.hasMore" @click="turnDetails(1)">下一页</button></div></div>
      </section>
      <section class="share-funnel-card data-trend"><div class="share-funnel-heading"><div><p class="eyebrow">每日趋势 · {{ trendReport?.filters.startDay }} 至 {{ trendReport?.filters.endDay }}</p><h2>{{ selectedMetric.label }}</h2></div><label>查看指标<select v-model="metric"><option v-for="item in metricOptions" :key="item.key" :value="item.key">{{ item.label }}</option></select></label></div>
        <p v-if="trendError" class="alert">近 30 天趋势读取失败，当前显示所选日期：{{ trendError }} <button :disabled="loading" @click="load">重试</button></p>
        <svg v-if="chart.hasData" viewBox="0 0 1000 290" role="img" :aria-label="selectedMetric.label + '每日趋势，具体数据见每日明细'">
          <g v-for="tick in chart.ticks" :key="tick.y"><line x1="100" x2="960" :y1="tick.y" :y2="tick.y" stroke="#e1e8e3" /><text x="90" :y="tick.y + 5" text-anchor="end">{{ format(tick.value, selectedMetric.format) }}</text></g>
          <polyline v-for="(segment, index) in chart.segments" :key="index" :points="segment" fill="none" stroke="#245c4a" stroke-width="3" />
          <circle v-for="point in chart.points.filter(item => item.value !== null)" :key="point.row.day" :cx="point.x" :cy="point.y" r="4" fill="#245c4a"><title>{{ point.row.day }}：{{ format(point.value, selectedMetric.format) }}{{ point.row.partial ? '（当日未结束）' : '' }}</title></circle>
          <text x="100" y="275">{{ trendReport?.filters.startDay }}</text><text x="960" y="275" text-anchor="end">{{ trendReport?.filters.endDay }}</text>
        </svg><p v-else class="data-quality">该指标尚未完整采集或没有可计算的分母。</p>
      </section>
      <section class="table-card"><div class="data-table-heading"><h2>每日明细</h2><button class="secondary compact" @click="sortDescending = !sortDescending">日期{{ sortDescending ? '从新到旧 ↓' : '从旧到新 ↑' }}</button></div>
        <div class="table-wrap"><table><thead><tr><th>日期</th><th v-for="column in columns" :key="column.key">{{ column.label }}</th></tr></thead><tbody><tr v-for="row in displayRows" :key="row.day"><td><strong>{{ row.day }}</strong><small v-if="row.partial">当日未结束</small><small v-if="!row.mature && ['growth', 'families'].includes(tab)">转化窗口未满</small></td><td v-for="column in columns" :key="column.key"><button class="data-cell-metric" :disabled="numberValue(row, column.key) === null || !canDrill(column.key) || loading || !!dirty || !!error" @click="openDetails(column.key, column.label, numberValue(row, column.key), row.day)">{{ format(numberValue(row, column.key), column.format) }}</button><small v-if="column.numerator">{{ format(numberValue(row, column.numerator)) }} / {{ format(numberValue(row, column.denominator!)) }}</small><small v-if="!row.activityComplete && (tab === 'activity' || ['enterRate', 'exampleRate'].includes(column.key))">未完整采集</small></td></tr></tbody></table></div>
      </section>
      <section v-if="tab === 'payment'" class="share-funnel-card"><div class="share-funnel-heading"><h2>商品结构</h2><small>收入按支付日 · 退款按退款日 · 净收款未扣平台费用</small></div><div v-if="report.sku.length" class="table-wrap"><table><thead><tr><th>商品</th><th>支付订单</th><th>支付金额</th></tr></thead><tbody><tr v-for="item in report.sku" :key="item.productId"><td>{{ item.name }}</td><td>{{ item.orders }}</td><td>{{ format(item.gmvCents, 'money') }}</td></tr></tbody></table></div><p v-else class="data-quality">当前日期和支付环境没有成功支付订单。</p></section>
      <details class="data-definitions"><summary>统计口径与历史数据边界</summary><ul>
        <li>新用户按首次建档日分组。示例体验单独统计；进入真实家谱指成功查看自己创建或已加入的家谱图或家庭页。邀请预览不计入。</li>
        <li>当天、7 天、30 天从首次进入或建谱当天起按北京时间自然日计算，观察至查询时点；未满窗口为暂定值。创建、加入、进入可以重叠，比例不相加；期间比例为总分子 ÷ 总分母。</li>
        <li>曾有家人加入：新建家谱在窗口内有非创建者加入。当前协作：同一批新谱在查询时点有效且仍有非创建者有效成员。仅查看用户也算家人，人物数量不代表加入用户数。</li>
        <li>日活用户按当天实际进入或使用小程序去重，包含浏览示例；日活家谱仅含被有效成员访问或操作的真实家谱。缓存展示也上报，旧客户端仅覆盖实际云端业务调用。</li>
        <li>订单支付转化按订单创建日分组，观察至查询时点；支付、退款各按实际发生日计金额。退款仍保留原支付人数。客单价＝支付金额 ÷ 支付订单，ARPPU＝支付金额 ÷ 付费人数。</li>
        <li>当前有效会员家谱按查询时点去重，与每日支付环境筛选无关。没有分母显示“—”；完整采集但无行为显示 0；缺失访问显示“—”。</li>
        <li>历史创建和加入以现存业务及保留记录补充，启用前已清理或被覆盖的记录可能缺失；历史访问不补造。后续清理保留无姓名、无 openid 的统计事实和聚合。明细快照有效 24 小时，详情访问继续受现有权限与审计控制。</li>
      </ul></details>
    </template>
  </section>
</template>
