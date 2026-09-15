<script setup>
import { defineAsyncComponent, onMounted, ref } from 'vue';
import { api } from './api.js';
import LoginView from './components/LoginView.vue';

const WorkspaceView = defineAsyncComponent(() => import('./components/WorkspaceView.vue'));

const user = ref(null);
const checking = ref(true);

onMounted(async () => {
  try {
    user.value = (await api.me()).user;
  } catch {
    user.value = null;
  } finally {
    checking.value = false;
  }
});

function loggedIn(nextUser) {
  user.value = nextUser;
}

async function logout() {
  await api.logout();
  user.value = null;
}
</script>

<template>
  <div v-if="checking" class="boot-screen">
    <div class="brand-mark">GS</div>
    <p>正在连接应用构建平台…</p>
  </div>
  <LoginView v-else-if="!user" @logged-in="loggedIn" />
  <WorkspaceView v-else :user="user" @logout="logout" />
</template>
