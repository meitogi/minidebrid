import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Served from https://<user>.github.io/debrid-remote/ (GitHub Pages project site).
export default defineConfig({
  base: '/debrid-remote/',
  plugins: [svelte()],
});
