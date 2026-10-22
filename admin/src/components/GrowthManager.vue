<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { callOps, getErrorMessage } from '../cloudbase';
interface Metrics { visitors: number; exampleVisitors: number; createClicks: number; newUsers: number; createdUsers: number; familiesWithRelatives: number; createRate: number | null; relativeRate: number | null; loadErrorVisitors: number; loadSuccessRate: number | null; clickRate: number | null }
interface Row extends Metrics { page: string; slug: string; entryType?: string; mature: boolean; collaborationMature: boolean }
interface Report { filters: { startDay: string; endDay: string; source: string }; totals: Metrics; defaultEntry?: Metrics & { mature: boolean; collaborationMature: boolean }; rows: Row[]; asOf: string; complete: boolean; mature: boolean; collaborationMature: boolean; trackingStartedAt: string | null }
const props = defineProps<{ refreshKey: number }>();
const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const start = ref(new Date(Date.now() - 29 * 86400000 + 8 * 3600000).toISOString().slice(0, 10));
const end = ref(today()); const source = ref('search'); const loading = ref(false); const error = ref(''); const report = ref<Report | null>(null);
let version = 0;
const dirty = computed(() => report.value && (report.value.filters.startDay !== start.value || report.value.filters.endDay !== end.value || report.value.filters.source !== source.value));
const columns: Array<{ key: keyof Metrics; title: string; rate?: boolean }> = [
  { key: 'visitors', title: '首次触达访客' }, { key: 'exampleVisitors', title: '体验示例' }, { key: 'createClicks', title: '点击创建' },
  { key: 'newUsers', title: '建档新用户' }, { key: 'createdUsers', title: '首次建谱新用户' }, { key: 'createRate', title: '访客建谱率', rate: true },
  { key: 'familiesWithRelatives', title: '7 天内有家人加入' }, { key: 'relativeRate', title: '家人加入比例', rate: true }
];
const pageNames: Record<string, string> = { 'pages/share-intro/index': '认识有谱', 'pages/about/index': '关于有谱', 'pages/guides/index': '修谱指南', 'pages/guide/index': '指南详情', 'pages/examples/index': '官方示例', 'pages/example/index': '示例图谱', 'pages/example-reading/index': '示例说明', 'pages/example-person-detail/index': '示例人物' };
const defaultColumns: Array<{ key: keyof Metrics; title: string; rate?: boolean }> = [
  { key: 'visitors', title: '入口去重访客' }, { key: 'loadSuccessRate', title: '示例加载成功率', rate: true },
  { key: 'loadErrorVisitors', title: '遇到加载失败' }, { key: 'clickRate', title: '创建点击率', rate: true },
  { key: 'createdUsers', title: '7 天首次建谱新用户' }, { key: 'createRate', title: '7 天首次建谱率', rate: true },
  { key: 'relativeRate', title: '建谱后 7 天家人加入比例', rate: true }
];
function format(value: number | null | undefined, rate?: boolean) { return value == null ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + (rate ? '%' : ''); }
async function load() {
  const request = ++version; loading.value = true; error.value = '';
  const filters = { startDay: start.value, endDay: end.value, source: source.value };
  try { const data = await callOps<Report>('growth.summary', filters); if (request === version) report.value = data; }
  catch (err) { if (request === version) error.value = getErrorMessage(err, '搜索获客数据读取失败'); }
  finally { if (request === version) loading.value = false; }
}
onMounted(load); watch(() => props.refreshKey, load); onBeforeUnmount(() => { version++; });
</script>

<template>
  <section class="growth-manager" :aria-busy="loading">
    <h2>搜索与公开内容获客</h2>
    <p>按首次触达日分组，观察 7 天内的新账号建谱，再观察建谱后 7 天的家人加入。未建档访客独立统计，测试及已识别爬虫不计入。</p>
    <form class="data-filter-fields" @submit.prevent="load">
      <label>首次触达开始<input v-model="start" type="date" :max="end" required /></label><label>首次触达结束<input v-model="end" type="date" :min="start" :max="today()" required /></label>
      <label>来源<select v-model="source"><option value="search">微信搜索场景</option><option value="share">聊天分享场景</option><option value="unknown">未知来源</option><option value="all">全部来源</option></select></label>
      <button class="primary compact" :disabled="loading">{{ loading ? '查询中…' : '查询获客数据' }}</button>
    </form>
    <p v-if="error" class="alert" role="alert">{{ error }}</p><p v-if="dirty" class="alert">筛选已修改，下方为上次查询结果。</p>
    <template v-if="report">
      <p>统计截止 {{ new Date(report.asOf).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) }} · 北京时间</p>
      <p v-if="!report.complete" class="alert">所选日期包含未完整采集的时间，结果仅代表已采集部分，不可当作完整零值。采集起点：{{ report.trackingStartedAt ? new Date(report.trackingStartedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '尚未初始化' }}。</p>
      <p v-if="!report.mature || !report.collaborationMature" class="alert">部分访客的建谱或家人加入观察窗口尚未结束，转化为暂定值。</p>
      <template v-if="report.defaultEntry"><h3>默认示例入口</h3><p>当前来源及首次触达日期筛选内，以默认示例首屏为首次入口的访客。曝光在加载前记录；失败后重试成功可同时计入成功与失败，成功率不等于 1 减失败率。后续从其他入口看示例或点击创建不计本首屏的加载与点击指标。</p><p v-if="!report.defaultEntry.mature || !report.defaultEntry.collaborationMature" class="alert">默认入口转化窗口尚未完整，结果为暂定值。</p><div class="data-kpis"><article v-for="column in defaultColumns" :key="column.key"><span>{{ column.title }}</span><strong>{{ format(report.defaultEntry[column.key], column.rate) }}</strong></article></div></template>
      <h3>公开内容获客汇总</h3><div class="data-kpis"><article v-for="column in columns" :key="column.key"><span>{{ column.title }}</span><strong>{{ format(report.totals[column.key], column.rate) }}</strong></article></div>
      <div class="table-wrap"><table><thead><tr><th>首次入口内容</th><th v-for="column in columns" :key="column.key">{{ column.title }}</th><th>观察窗口</th></tr></thead><tbody>
        <tr v-for="row in report.rows" :key="row.page + row.slug + (row.entryType || '')"><td>{{ row.entryType === 'default_example' ? '默认示例首屏' : pageNames[row.page] || row.page }}<small v-if="row.slug"> · {{ row.slug }}</small></td><td v-for="column in columns" :key="column.key">{{ format(row[column.key], column.rate) }}</td><td>{{ row.mature && row.collaborationMature ? '已满' : '暂定' }}</td></tr>
        <tr v-if="!report.rows.length"><td :colspan="columns.length + 2">当前筛选暂无已采集记录；不代表微信未抓取或收录。</td></tr>
      </tbody></table></div>
      <small>来源取自客户端上报的微信场景，不是微信官方曝光报表；无法取得身份的访问不计用户级漏斗。收录量请在微信平台核对。历史账号不计本次新用户转化。</small>
    </template>
  </section>
</template>

<style scoped>
.growth-manager { padding: 20px 0; border-bottom: 1px solid #dce4df; margin-bottom: 24px; }
.growth-manager p { line-height: 1.7; }
.growth-manager strong { display: block; font-size: 28px; margin-top: 10px; }
.growth-manager small { display: block; line-height: 1.7; color: #65706a; }
</style>
