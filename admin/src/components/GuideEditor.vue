<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { EditorContent, useEditor, type JSONContent } from '@tiptap/vue-3';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { callOps, getErrorMessage } from '../cloudbase';
import { stableStringify, storedDocument } from '../guide-document.js';

const props = defineProps<{ modelValue: JSONContent; guideId: string; imageUrls: Record<string, string>; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: JSONContent]; busy: [value: boolean]; uploaded: [value: { assetId: string; url: string }] }>();
const uploading = ref(false);
const imageError = ref('');
let applying = false;
let alive = true;
let pendingUpload: { imageData: string; requestId: string } | null = null;
const GuideImage = Image.extend({
  addAttributes() { return { ...this.parent?.(), assetId: { default: null }, width: { default: null }, height: { default: null } }; }
});
function editableDocument(value: JSONContent): JSONContent {
  const copy: JSONContent = JSON.parse(JSON.stringify(value));
  function walk(node: JSONContent): void {
    if (node.type === 'image') node.attrs = { ...node.attrs, src: props.imageUrls[node.attrs?.assetId] || '' };
    node.content?.forEach(walk);
  }
  walk(copy); return copy;
}
const editor = useEditor({
  extensions: [StarterKit.configure({ heading: { levels: [2, 3] }, code: false, codeBlock: false, horizontalRule: false, strike: false, link: false, trailingNode: false }), GuideImage],
  content: editableDocument(props.modelValue),
  editable: !props.disabled,
  onUpdate({ editor: instance }) { if (!applying) emit('update:modelValue', storedDocument(instance.getJSON())); }
});
watch(() => props.modelValue, value => {
  if (!editor.value || stableStringify(storedDocument(editor.value.getJSON())) === stableStringify(storedDocument(value))) return;
  applying = true; editor.value.commands.setContent(editableDocument(value), { emitUpdate: false }); applying = false;
}, { deep: true });
watch(() => props.disabled, value => editor.value?.setEditable(!value));
watch(() => props.imageUrls, () => {
  if (!editor.value) return;
  applying = true; editor.value.commands.setContent(editableDocument(props.modelValue), { emitUpdate: false }); applying = false;
}, { deep: true });
async function uploadPending(): Promise<void> {
  if (!pendingUpload || uploading.value) return;
  uploading.value = true; emit('busy', true); imageError.value = '';
  try {
    const data = await callOps<{ assetId: string; url: string }>('guides.image.upload', { guideId: props.guideId, ...pendingUpload });
    editor.value?.chain().focus().insertContent({ type: 'image', attrs: { assetId: data.assetId, src: data.url, alt: '', title: '' } }).run();
    emit('uploaded', data);
    pendingUpload = null;
  } catch (error) { imageError.value = getErrorMessage(error, '图片上传失败'); }
  finally { uploading.value = false; emit('busy', false); }
}
async function selectImage(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement; const file = input.files?.[0]; input.value = ''; imageError.value = ''; pendingUpload = null;
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 1024 * 1024) { imageError.value = '请选择1MB以内的PNG、JPEG或WebP图片'; return; }
  emit('busy', true);
  const owner = props.guideId;
  const imageData = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); }).catch(() => '');
  if (!alive || props.guideId !== owner) return;
  if (!imageData) { imageError.value = '读取图片失败，请重新选择'; emit('busy', false); return; }
  pendingUpload = { imageData, requestId: crypto.randomUUID() }; await uploadPending();
}
onBeforeUnmount(() => { alive = false; editor.value?.destroy(); });
</script>

<template>
  <div class="guide-editor">
    <div v-if="editor" class="rich-toolbar" role="toolbar" aria-label="正文格式">
      <button type="button" :disabled="disabled" :class="{ active: editor.isActive('heading', { level: 2 }) }" @click="editor.chain().focus().toggleHeading({ level: 2 }).run()">标题</button>
      <button type="button" :disabled="disabled" @click="editor.chain().focus().toggleHeading({ level: 3 }).run()">小标题</button>
      <button type="button" :disabled="disabled" :class="{ active: editor.isActive('bold') }" @click="editor.chain().focus().toggleBold().run()"><b>加粗</b></button>
      <button type="button" :disabled="disabled" @click="editor.chain().focus().toggleItalic().run()"><i>斜体</i></button>
      <button type="button" :disabled="disabled" @click="editor.chain().focus().toggleUnderline().run()"><u>下划线</u></button>
      <button type="button" :disabled="disabled" @click="editor.chain().focus().toggleBulletList().run()">项目列表</button>
      <button type="button" :disabled="disabled" @click="editor.chain().focus().toggleOrderedList().run()">编号列表</button>
      <button type="button" :disabled="disabled" @click="editor.chain().focus().toggleBlockquote().run()">引用</button>
      <label class="image-picker">{{ uploading ? '上传中…' : '插入图片' }}<input type="file" accept="image/png,image/jpeg,image/webp" :disabled="disabled || uploading || !guideId" @change="selectImage" /></label>
      <button type="button" :disabled="disabled || !editor.can().undo()" @click="editor.chain().focus().undo().run()">撤销</button>
      <button type="button" :disabled="disabled || !editor.can().redo()" @click="editor.chain().focus().redo().run()">重做</button>
    </div>
    <p v-if="!guideId" class="editor-hint">先保存新指南，再插入图片。支持PNG、JPEG、WebP，单张最多1MB。</p>
    <p v-if="imageError" class="image-error">{{ imageError }} <button type="button" :disabled="uploading || !pendingUpload" @click="uploadPending">重试上传</button></p>
    <EditorContent :editor="editor" />
  </div>
</template>

<style scoped>
.guide-editor{border:1px solid #ccd9d0;border-radius:12px;overflow:hidden}.rich-toolbar{display:flex;flex-wrap:wrap;gap:5px;padding:10px;background:#f4f7f3;border-bottom:1px solid #dce5dd}.rich-toolbar button,.image-picker{padding:7px 10px;min-height:34px;font-size:12px;border:1px solid #d2ded5;border-radius:6px;background:white;cursor:pointer}.rich-toolbar .active{background:#e0eee5;color:#245c4a}.image-picker input{display:none}.editor-hint,.image-error{margin:10px 16px;font-size:12px}.image-error{color:#a13535}:deep(.tiptap){padding:20px;min-height:330px;outline:none;font-size:16px;line-height:1.9;overflow-wrap:anywhere}:deep(.tiptap p){margin:.8em 0}:deep(.tiptap h2){font-size:1.25em;line-height:1.6;margin:1.2em 0 .6em}:deep(.tiptap h3){font-size:1.12em;line-height:1.6}:deep(.tiptap img){max-width:100%;height:auto;display:block;margin:1em 0}:deep(.tiptap blockquote){margin:1em 0;padding-left:1em;border-left:3px solid #c5d6cc;color:#65706a}
</style>
