<script setup>
import { ref } from 'vue';
import { api } from '../api.js';

const emit = defineEmits(['logged-in']);
const username = ref('admin');
const password = ref('Admin123!');
const busy = ref(false);
const error = ref('');

async function submit() {
  busy.value = true;
  error.value = '';
  try {
    const result = await api.login(username.value, password.value);
    emit('logged-in', result.user);
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    busy.value = false;
  }
}

function useDemo(account) {
  const passwords = { admin: 'Admin123!', editor: 'Editor123!', viewer: 'Viewer123!' };
  username.value = account;
  password.value = passwords[account];
}
</script>

<template>
  <main class="login-page">
    <section class="login-intro">
      <div class="eyebrow">GENERIC SHEET APP BUILDER</div>
      <h1>用熟悉的表格，<br />构建可运行的数据应用。</h1>
      <p>保留电子表格的录入与计算习惯，通过模板、结构化记录和关系配置组成通用应用。</p>
      <div class="feature-line">
        <span>多工作表</span><span>公式计算</span><span>数据库保存</span><span>版本记录</span>
      </div>
    </section>

    <section class="login-card">
      <div class="brand-row">
        <div class="brand-mark">GS</div>
        <div><strong>表格应用构建平台</strong><small>开源项目预览 · 通用合成示例</small></div>
      </div>
      <form @submit.prevent="submit">
        <label>账号<input v-model="username" autocomplete="username" /></label>
        <label>密码<input v-model="password" type="password" autocomplete="current-password" /></label>
        <p v-if="error" class="form-error">{{ error }}</p>
        <button class="primary-button login-button" :disabled="busy">{{ busy ? '正在登录…' : '进入工作台' }}</button>
      </form>
      <div class="demo-accounts">
        <span>快速体验</span>
        <button @click="useDemo('admin')">设计者</button>
        <button @click="useDemo('editor')">使用者</button>
        <button @click="useDemo('viewer')">查看者</button>
      </div>
    </section>
  </main>
</template>
