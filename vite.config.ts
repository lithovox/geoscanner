import { defineConfig } from 'vite';

export default defineConfig({
  base: '/',
  preview: {
    allowedHosts: [
      'geoscanner.lithovox.nl',
      'localhost'
    ]
  },
  server: {
    allowedHosts: [
      'geoscanner.lithovox.nl',
      'localhost'
    ]
  }
});
