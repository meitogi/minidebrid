import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Served from https://meitogi.github.io/minidebrid/ (GitHub Pages project site = repo name).
export default defineConfig({
  base: '/minidebrid/',
  plugins: [svelte()],
});
