<script setup lang="ts">
import { computed } from 'vue';
import { EditorContent, useEditor, type JSONContent } from '@tiptap/vue-3';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
const props = defineProps<{ title: string; summary: string; body: JSONContent; imageUrls: Record<string, string> }>();
const doc = computed(() => {
  const copy = JSON.parse(JSON.stringify(props.body)) as JSONContent;
  function walk(node: JSONContent): void { if (node.type === 'image') node.attrs = { ...node.attrs, src: props.imageUrls[node.attrs?.assetId] || '' }; node.content?.forEach(walk); }
  walk(copy); return copy;
});
// The preview is recreated by its parent when opened, with current unsaved data.
const editor = useEditor({ extensions: [StarterKit.configure({ link: false }), Image], content: doc.value, editable: false });
</script>
<template>
  <article class="guide-phone-preview"><h1>{{ title }}</h1><p class="summary">{{ summary }}</p><EditorContent :editor="editor" /></article>
</template>
<style scoped>
.guide-phone-preview{width:375px;max-width:100%;padding:22px;margin:12px auto;background:#fffdf8;border:1px solid #dae3dc;border-radius:16px;font-size:16px;line-height:1.9;overflow-wrap:anywhere}.guide-phone-preview h1{font-size:24px;line-height:1.5;color:#245c4a}.summary{color:#65706a}:deep(.tiptap){outline:none}:deep(p){margin:.8em 0}:deep(h2){font-size:1.25em;line-height:1.6;margin:1.2em 0 .6em}:deep(h3){font-size:1.12em;line-height:1.6}:deep(img){max-width:100%;height:auto;display:block;margin:1em 0}:deep(blockquote){margin:1em 0;padding-left:1em;border-left:3px solid #c5d6cc;color:#65706a}
</style>
