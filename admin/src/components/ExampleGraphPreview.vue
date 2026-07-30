<script setup lang="ts">
// The admin preview imports the same pure CommonJS layout module used by the
// mini program, so relationship coordinates cannot drift between surfaces.
// @ts-ignore The mini-program utility is CommonJS and Vite converts it at build time.
import graphLayout from '../../../miniprogram/utils/graph-layout.js';
import { computed, ref } from 'vue';

type Row = Record<string, any>;
const props = defineProps<{ persons: Row[]; relations: Row[]; selectedPersonId?: string; selectedRelationId?: string }>();
const emit = defineEmits<{ selectPerson: [id: string]; selectRelation: [id: string] }>();
const zoom = ref(0.72);
const pan = ref({ x: 0, y: 0 });
const drag = ref<{ x: number; y: number; panX: number; panY: number } | null>(null);

const layout = computed(() => graphLayout.layoutGraph(props.persons || [], props.relations || [], {
  mode: 'full', viewpointId: '', collapsedIds: [], selectedPersonId: props.selectedPersonId || ''
}));
const viewBox = computed(() => `0 0 ${layout.value.width} ${layout.value.height}`);
function segment(style: string): Row | null {
  const left = /left:([-\d.]+)rpx/.exec(style); const top = /top:([-\d.]+)rpx/.exec(style);
  const width = /width:([-\d.]+)rpx/.exec(style); const angle = /rotate\(([-\d.]+)deg\)/.exec(style);
  if (!left || !top || !width || !angle) return null;
  const x1 = Number(left[1]); const y1 = Number(top[1]); const length = Number(width[1]); const radians = Number(angle[1]) * Math.PI / 180;
  return { x1, y1, x2: x1 + Math.cos(radians) * length, y2: y1 + Math.sin(radians) * length };
}
function relationIdForLine(line: Row): string {
  if (line.type === 'spouse' && String(line._id || '').startsWith('spouse-')) return String(line._id).slice(7);
  if (line.lineRole !== 'drop') return '';
  const id = String(line._id || '');
  const child = (props.relations || []).find((relation: Row) => relation.type === 'parent_child' && id.endsWith(`-${relation.toPersonId}`) && id.includes(relation.fromPersonId));
  return child?._id || '';
}
const lines = computed(() => layout.value.lines.map((line: Row) => Object.assign({}, line, { points: segment(line.style), relationId: relationIdForLine(line) })).filter((line: Row) => line.points));
const nodesById = computed(() => Object.fromEntries(layout.value.nodes.map((node: Row) => [node._id, node])));
type RelationHit = { _id: string; type: string; x1: number; y1: number; x2: number; y2: number };
const relationHits = computed<RelationHit[]>(() => (props.relations || []).map((relation: Row): RelationHit | null => {
  const from = nodesById.value[relation.fromPersonId]; const to = nodesById.value[relation.toPersonId];
  if (!from || !to) return null;
  return {
    _id: relation._id, type: relation.type,
    x1: from.x + 84, y1: relation.type === 'spouse' ? from.y + 58 : from.y + 116,
    x2: to.x + 84, y2: relation.type === 'spouse' ? to.y + 58 : to.y
  };
}).filter((hit): hit is RelationHit => Boolean(hit)));
function resetView(): void { zoom.value = 0.72; pan.value = { x: 0, y: 0 }; }
function onWheel(event: WheelEvent): void { event.preventDefault(); zoom.value = Math.max(0.35, Math.min(1.6, zoom.value + (event.deltaY < 0 ? 0.08 : -0.08))); }
function onPointerDown(event: PointerEvent): void { drag.value = { x: event.clientX, y: event.clientY, panX: pan.value.x, panY: pan.value.y }; (event.currentTarget as Element).setPointerCapture(event.pointerId); }
function onPointerMove(event: PointerEvent): void { if (drag.value) pan.value = { x: drag.value.panX + event.clientX - drag.value.x, y: drag.value.panY + event.clientY - drag.value.y }; }
function onPointerUp(): void { drag.value = null; }
</script>

<template>
  <div class="graph-preview">
    <div class="graph-preview-tools"><span>实时关系图</span><button type="button" @click="zoom = Math.min(1.6, zoom + .12)">＋</button><button type="button" @click="zoom = Math.max(.35, zoom - .12)">－</button><button type="button" @click="resetView">适配</button></div>
    <div class="graph-stage" @wheel="onWheel" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerUp">
      <svg :viewBox="viewBox" :style="{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }" aria-label="示例家谱关系图">
        <line v-for="line in lines" :key="line._id" :x1="line.points.x1" :y1="line.points.y1" :x2="line.points.x2" :y2="line.points.y2" :class="['graph-line', `line-${line.lineRole}`, { flow: line.isFlow, clickable: line.relationId, selected: line.relationId === selectedRelationId }]" @click.stop="line.relationId && emit('selectRelation', line.relationId)" />
        <line v-for="hit in relationHits" :key="`hit-${hit._id}`" :x1="hit.x1" :y1="hit.y1" :x2="hit.x2" :y2="hit.y2" class="relation-hit" :class="{ selected: hit._id === selectedRelationId }" @click.stop="emit('selectRelation', hit._id)" />
        <g v-for="node in layout.nodes" :key="node._id" class="graph-node" :class="{ selected: node._id === selectedPersonId }" :transform="`translate(${node.x}, ${node.y})`" @click.stop="emit('selectPerson', node._id)"><rect width="168" height="116" rx="18"/><text x="84" y="47" text-anchor="middle" class="node-name">{{ node.name || '未命名人物' }}</text><text x="84" y="76" text-anchor="middle" class="node-meta">{{ node.relationLabel || (node.gender === 'male' ? '男' : node.gender === 'female' ? '女' : '未填写') }}</text></g>
      </svg>
      <p v-if="!layout.nodes.length" class="empty">添加人物和关系后会在这里显示关系图。</p>
    </div>
  </div>
</template>

<style scoped>
.graph-preview { overflow:hidden; border:1px solid #dfe7e2; border-radius:14px; }.graph-preview-tools { min-height:42px; padding:0 12px; display:flex; align-items:center; gap:7px; color:#315143; background:#f5f8f5; font-size:12px; font-weight:700; }.graph-preview-tools span { flex:1; }.graph-preview-tools button { min-width:31px; height:27px; padding:0 8px; color:#245c4a; background:#fff; border:1px solid #ccd8d1; border-radius:7px; font-size:12px; }.graph-stage { position:relative; height:420px; overflow:hidden; touch-action:none; background-color:#fbfcfa; background-image:radial-gradient(rgba(36,92,74,.12) 1px,transparent 1px); background-size:16px 16px; cursor:grab; }.graph-stage:active { cursor:grabbing; }.graph-stage svg { width:100%; height:100%; transform-origin:center; transition:transform 80ms linear; }.graph-line { stroke:#a6b7ae; stroke-width:4; stroke-linecap:round; pointer-events:none; }.graph-line.clickable { pointer-events:stroke; cursor:pointer; }.graph-line.selected { stroke:#c18a32; stroke-width:7; }.line-spouse { stroke:#829d91; stroke-width:5; }.line-rail { stroke:#bec9c3; stroke-width:3; }.relation-hit { stroke:transparent; stroke-width:18; cursor:pointer; }.relation-hit.selected { stroke:rgba(193,138,50,.42); }.graph-node { cursor:pointer; }.graph-node rect { fill:#fffefa; stroke:#d8ded9; stroke-width:2; }.graph-node.selected rect { stroke:#c18a32; stroke-width:5; }.node-name { fill:#202824; font-size:24px; font-weight:700; }.node-meta { fill:#65706a; font-size:18px; }.empty { position:absolute; inset:0; display:grid; place-items:center; color:#718079; font-size:13px; }
</style>
