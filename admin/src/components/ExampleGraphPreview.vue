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
const pendingRelationIds = ref<string[]>([]);

const layout = computed(() => graphLayout.layoutGraph(props.persons || [], props.relations || [], {
  mode: 'full', viewpointId: '', collapsedIds: [], selectedPersonId: props.selectedPersonId || ''
}));
const viewBox = computed(() => `0 0 ${layout.value.width} ${layout.value.height}`);
const lines = computed<Row[]>(() => (layout.value.lines as Row[]).filter((line: Row) => !line.isFlow));
const relationHits = computed<Row[]>(() => lines.value.filter((line: Row) => line.relationIds?.length));
const relationsById = computed<Record<string, Row>>(() => Object.fromEntries((props.relations || []).map((relation: Row) => [relation._id, relation])));
const namesById = computed<Record<string, string>>(() => Object.fromEntries((props.persons || []).map((person: Row) => [person._id, person.name || '未命名人物'])));
const nodeWidth = computed(() => layout.value.nodeWidth || 168);
const nodeHeight = computed(() => layout.value.nodeHeight || 164);
function chooseLine(line: Row): void {
  const ids = Array.from(new Set((line.relationIds || []) as string[])).filter((id: string) => relationsById.value[id]);
  if (ids.length === 1) { pendingRelationIds.value = []; emit('selectRelation', ids[0]); }
  else pendingRelationIds.value = ids;
}
function relationLabel(id: string): string {
  const relation = relationsById.value[id];
  if (!relation) return id;
  const from = namesById.value[relation.fromPersonId] || '未命名人物';
  const to = namesById.value[relation.toPersonId] || '未命名人物';
  return relation.type === 'spouse' ? `${from}—${to} · 配偶` : `${from}→${to} · 亲子`;
}
function chooseRelation(id: string): void { pendingRelationIds.value = []; emit('selectRelation', id); }
function resetView(): void { zoom.value = 0.72; pan.value = { x: 0, y: 0 }; }
function onWheel(event: WheelEvent): void { event.preventDefault(); zoom.value = Math.max(0.35, Math.min(1.6, zoom.value + (event.deltaY < 0 ? 0.08 : -0.08))); }
function onPointerDown(event: PointerEvent): void {
  if ((event.target as Element).closest('.relation-hit, .graph-node')) return;
  drag.value = { x: event.clientX, y: event.clientY, panX: pan.value.x, panY: pan.value.y };
  (event.currentTarget as Element).setPointerCapture(event.pointerId);
}
function onPointerMove(event: PointerEvent): void { if (drag.value) pan.value = { x: drag.value.panX + event.clientX - drag.value.x, y: drag.value.panY + event.clientY - drag.value.y }; }
function onPointerUp(): void { drag.value = null; }
</script>

<template>
  <div class="graph-preview">
    <div class="graph-preview-tools"><span>实时关系图</span><button type="button" @click="zoom = Math.min(1.6, zoom + .12)">＋</button><button type="button" @click="zoom = Math.max(.35, zoom - .12)">－</button><button type="button" @click="resetView">适配</button></div>
    <div class="graph-stage" @wheel="onWheel" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerUp">
      <svg :viewBox="viewBox" :style="{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }" aria-label="示例家谱关系图">
        <line v-for="line in lines" :key="line._id" :x1="line.x1" :y1="line.y1" :x2="line.x2" :y2="line.y2" :class="['graph-line', `line-${line.lineRole}`, { flow: line.isFlow, selected: line.relationIds?.includes(selectedRelationId) }]" />
        <g v-for="crossing in layout.crossings" :key="crossing._id" class="line-crossing" :class="{ 'is-spouse': crossing.isSpouse }"><circle :cx="crossing.x" :cy="crossing.y" r="7"/><line :x1="crossing.x" :x2="crossing.x" :y1="crossing.y - 7" :y2="crossing.y + 7"/></g>
        <line v-for="hit in relationHits" :key="`hit-${hit._id}`" :x1="hit.x1" :y1="hit.y1" :x2="hit.x2" :y2="hit.y2" class="relation-hit" @click.stop="chooseLine(hit)" />
        <g v-for="node in layout.nodes" :key="node._id" class="graph-node" :class="[node.genderClass, { selected: node._id === selectedPersonId }]" :transform="`translate(${node.x}, ${node.y})`" @click.stop="emit('selectPerson', node._id)">
          <rect class="node-card" :width="nodeWidth" :height="nodeHeight" rx="18"/>
          <rect class="gender-marker" x="8" y="8" width="38" height="24" rx="12"/>
          <text x="27" y="25" text-anchor="middle" class="gender-marker-text">{{ node.genderText }}</text>
          <text :x="nodeWidth / 2" :y="nodeHeight / 2 - 15" text-anchor="middle" class="node-name">{{ node.name || '未命名人物' }}</text>
          <text :x="nodeWidth / 2" :y="nodeHeight / 2 + 18" text-anchor="middle" class="node-meta">{{ node.relationLabel || node.genderText }}</text>
        </g>
      </svg>
      <p v-if="!layout.nodes.length" class="empty">添加人物和关系后会在这里显示关系图。</p>
    </div>
    <div v-if="pendingRelationIds.length" class="relation-choice"><span>选择要定位的关系</span><button v-for="id in pendingRelationIds" :key="id" type="button" @click="chooseRelation(id)">{{ relationLabel(id) }}</button><button type="button" class="choice-close" @click="pendingRelationIds = []">取消</button></div>
  </div>
</template>

<style scoped>
.graph-preview { overflow:hidden; border:1px solid #dfe7e2; border-radius:14px; }.graph-preview-tools { min-height:42px; padding:0 12px; display:flex; align-items:center; gap:7px; color:#315143; background:#f5f8f5; font-size:12px; font-weight:700; }.graph-preview-tools span { flex:1; }.graph-preview-tools button { min-width:31px; height:27px; padding:0 8px; color:#245c4a; background:#fff; border:1px solid #ccd8d1; border-radius:7px; font-size:12px; }.graph-stage { position:relative; height:420px; overflow:hidden; touch-action:none; background-color:#fbfcfa; background-image:radial-gradient(rgba(36,92,74,.12) 1px,transparent 1px); background-size:16px 16px; cursor:grab; }.graph-stage:active { cursor:grabbing; }.graph-stage svg { width:100%; height:100%; transform-origin:center; transition:transform 80ms linear; }.graph-line { stroke:#a6b7ae; stroke-width:4; stroke-linecap:round; pointer-events:none; }.graph-line.selected { stroke:#c18a32; stroke-width:7; }.line-spouse { stroke:#829d91; stroke-width:5; }.line-rail { stroke:#bec9c3; stroke-width:3; }.relation-hit { stroke:transparent; stroke-width:18; cursor:pointer; }.graph-node { cursor:pointer; }.graph-node .node-card { fill:#ecefed; stroke:#65706a; stroke-width:2; }.graph-node.gender-male .node-card { fill:#e6eff5; stroke:#416b89; }.graph-node.gender-female .node-card { fill:#f5e7eb; stroke:#985565; }.graph-node.selected .node-card { stroke:#c18a32; stroke-width:5; }.gender-marker { fill:#65706a; stroke:none; }.gender-male .gender-marker { fill:#416b89; }.gender-female .gender-marker { fill:#985565; }.gender-marker-text { fill:#fff; font-size:13px; font-weight:700; }.node-name { fill:#202824; font-size:24px; font-weight:700; }.node-meta { fill:#65706a; font-size:18px; }.empty { position:absolute; inset:0; display:grid; place-items:center; color:#718079; font-size:13px; }
.line-crossing { pointer-events:none; }
.line-crossing circle { fill:#f7f4ec; }
.line-crossing line { stroke:#a6b7ae; stroke-width:4; }
.line-crossing.is-spouse line { stroke:#829d91; }
.relation-choice { max-height:160px; padding:10px 12px; display:flex; flex-wrap:wrap; align-items:center; gap:8px; overflow-y:auto; border-top:1px solid #dfe7e2; background:#fffefa; font-size:12px; }
.relation-choice button { padding:6px 9px; color:#245c4a; background:#fff; border:1px solid #ccd8d1; border-radius:7px; cursor:pointer; }
.relation-choice .choice-close { margin-left:auto; }
</style>
