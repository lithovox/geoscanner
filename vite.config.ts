import { defineConfig } from 'vite';

export default defineConfig({
  // Configure base path if serving under /geoscanner/
  base: '/geoscanner/',
  preview: {
    allowedHosts: [
      'app.breinbaas.nl',
      'apps.breinbaas.nl',
      'localhost'
    ]
    // Or set to true to allow all hosts behind your proxy:
    // allowedHosts: true
  },
  server: {
    allowedHosts: [
      'app.breinbaas.nl',
      'apps.breinbaas.nl',
      'localhost'
    ]
  }
});