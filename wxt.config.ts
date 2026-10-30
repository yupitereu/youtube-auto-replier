import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  zip: {
    exclude: ['fixtures/**'],
  },
  manifest: {
    minimum_chrome_version: '116',
    name: '유튜브 답글 도우미',
    description: '댓글을 선택하고, 닉네임을 담은 답글을 한 번에 등록하세요.',
    permissions: ['activeTab', 'scripting', 'storage', 'sidePanel'],
    host_permissions: ['https://www.youtube.com/*'],
    icons: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' },
    action: { default_title: '유튜브 답글 도우미 열기', default_icon: { 16: 'icon/16.png', 32: 'icon/32.png' } },
  },
});
