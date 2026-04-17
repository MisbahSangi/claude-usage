import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'Claude Usage Pro V4',
  version: '0.1.0',
  permissions: ['storage', 'scripting'],
  host_permissions: ['https://claude.ai/*'],
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },
  action: {
    default_popup: 'src/popup/popup.html',
  },
  content_scripts: [
    {
      matches: ['https://claude.ai/*'],
      js: ['src/content/content.ts'],
      css: ['src/content/widget.css'],
    },
  ],
  web_accessible_resources: [
    {
      resources: ['src/interceptor/interceptor.js'],
      matches: ['https://claude.ai/*'],
    },
  ],
});
