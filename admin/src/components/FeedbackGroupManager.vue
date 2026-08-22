<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { callOps, getErrorMessage } from '../cloudbase';

interface FeedbackGroupConfig {
  available: boolean;
  qrCodeUrl: string;
  updatedAt: string | null;
}

const config = ref<FeedbackGroupConfig>({ available: false, qrCodeUrl: '', updatedAt: null });
const imageData = ref('');
const selectedName = ref('');
const localPreviewUrl = ref('');
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const notice = ref('');

function formatDate(value: string | null): string {
  if (!value) return '尚未配置';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '刚刚更新' : date.toLocaleString('zh-CN', { hour12: false });
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    config.value = await callOps<FeedbackGroupConfig>('feedbackGroup.get');
  } catch (err) {
    error.value = getErrorMessage(err, '反馈群配置加载失败');
  } finally {
    loading.value = false;
  }
}

function selectImage(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files && input.files[0];
  error.value = '';
  notice.value = '';
  imageData.value = '';
  selectedName.value = '';
  if (localPreviewUrl.value) URL.revokeObjectURL(localPreviewUrl.value);
  localPreviewUrl.value = '';
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    error.value = '请选择 PNG、JPEG 或 WebP 格式的二维码图片。';
    input.value = '';
    return;
  }
  if (file.size > 1024 * 1024) {
    error.value = '二维码图片不能超过 1MB。';
    input.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = function () {
    imageData.value = String(reader.result || '');
    selectedName.value = file.name;
    localPreviewUrl.value = URL.createObjectURL(file);
  };
  reader.onerror = function () { error.value = '读取二维码图片失败，请重新选择。'; };
  reader.readAsDataURL(file);
}

async function replaceQrCode(): Promise<void> {
  if (!imageData.value || saving.value) return;
  if (!window.confirm('确认替换用户反馈群二维码？新二维码会立即向小程序用户展示。')) return;
  saving.value = true;
  error.value = '';
  notice.value = '';
  try {
    config.value = await callOps<FeedbackGroupConfig>('feedbackGroup.update', { imageData: imageData.value });
    imageData.value = '';
    selectedName.value = '';
    if (localPreviewUrl.value) URL.revokeObjectURL(localPreviewUrl.value);
    localPreviewUrl.value = '';
    notice.value = '反馈群二维码已替换并记录运营审计。';
  } catch (err) {
    error.value = getErrorMessage(err, '二维码替换失败');
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="feedback-manager">
    <p v-if="error" class="feedback-alert error">{{ error }}</p>
    <p v-if="notice" class="feedback-alert success">{{ notice }}</p>
    <div v-if="loading" class="feedback-loading">正在读取反馈群配置…</div>
    <div v-else class="feedback-grid">
      <article class="feedback-card">
        <p class="eyebrow">当前生效内容</p>
        <h2>用户反馈微信群</h2>
        <img v-if="config.available" :src="config.qrCodeUrl" alt="当前用户反馈群二维码" class="feedback-qr" />
        <div v-else class="feedback-empty">暂未上传二维码</div>
        <p class="muted">最近更新：{{ formatDate(config.updatedAt) }}</p>
      </article>
      <form class="feedback-card" @submit.prevent="replaceQrCode">
        <p class="eyebrow">替换二维码</p>
        <h2>上传新的群二维码</h2>
        <p class="muted">支持 PNG、JPEG、WebP，最大 1MB。替换后小程序将展示新二维码。</p>
        <label class="upload-control">选择二维码图片<input type="file" accept="image/png,image/jpeg,image/webp" @change="selectImage" /></label>
        <p v-if="selectedName" class="selected-file">已选择：{{ selectedName }}</p>
        <img v-if="localPreviewUrl" :src="localPreviewUrl" alt="待替换二维码预览" class="feedback-qr preview" />
        <button class="primary" type="submit" :disabled="!imageData || saving">{{ saving ? '正在替换…' : '确认替换二维码' }}</button>
      </form>
    </div>
  </section>
</template>

<style scoped>
.feedback-manager { display: grid; gap: 16px; }
.feedback-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
.feedback-card { padding: 28px; border: 1px solid #dde5df; border-radius: 18px; background: #fffefa; display: flex; flex-direction: column; align-items: flex-start; gap: 14px; }
.feedback-card h2 { margin: 0; font-size: 22px; }
.feedback-card .muted { margin: 0; line-height: 1.6; }
.feedback-qr { width: min(100%, 280px); aspect-ratio: 1; object-fit: contain; border: 1px solid #e5ebe6; border-radius: 12px; background: white; }
.feedback-qr.preview { margin-top: 4px; }
.feedback-empty { width: min(100%, 280px); aspect-ratio: 1; display: grid; place-items: center; color: #6b7670; background: #f1f5f1; border-radius: 12px; }
.upload-control { display: inline-flex; align-items: center; min-height: 42px; padding: 0 14px; border: 1px solid #cdd9d0; border-radius: 10px; color: #245c4a; font-weight: 600; cursor: pointer; }
.upload-control input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.selected-file { margin: 0; color: #59655e; font-size: 14px; }
.feedback-alert { margin: 0; padding: 12px 14px; border-radius: 10px; }
.feedback-alert.error { color: #9d3131; background: #fff0ef; }
.feedback-alert.success { color: #245c4a; background: #edf8f0; }
.feedback-loading { padding: 36px; color: #65706a; text-align: center; }
@media (max-width: 760px) { .feedback-grid { grid-template-columns: 1fr; } }
</style>
