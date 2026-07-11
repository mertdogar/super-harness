import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'super-harness',
  description:
    'A transparent, durable multi-agent harness for TypeScript, Mastra, and super-line.',
  base: '/super-harness/',
  cleanUrls: true,
  lastUpdated: true,
  head: [['link', { rel: 'icon', href: '/mark.svg' }]],
  themeConfig: {
    logo: '/mark.svg',
    nav: [
      { text: 'Tutorials', link: '/tutorials/', activeMatch: '/tutorials/' },
      { text: 'Guides', link: '/guides/', activeMatch: '/guides/' },
      { text: 'Concepts', link: '/concepts/', activeMatch: '/concepts/' },
      { text: 'Reference', link: '/reference/', activeMatch: '/reference/' },
      { text: 'Examples', link: '/examples/' },
    ],
    sidebar: {
      '/tutorials/': [
        {
          text: 'Tutorials',
          items: [
            { text: 'The learning path', link: '/tutorials/' },
            { text: 'Your first harness', link: '/tutorials/first-harness' },
            { text: 'Add the server plugin', link: '/tutorials/server-plugin' },
          ],
        },
      ],
      '/guides/': [
        {
          text: 'Build with Super Harness',
          items: [
            { text: 'Compose into a host', link: '/guides/composition' },
            { text: 'Human-in-the-loop controls', link: '/guides/human-in-the-loop' },
            { text: 'Use the React client', link: '/guides/react' },
            { text: 'Run the terminal client', link: '/guides/tui' },
            { text: 'Choose durable storage', link: '/guides/storage' },
          ],
        },
      ],
      '/concepts/': [
        {
          text: 'Concepts',
          items: [
            { text: 'Why Super Harness', link: '/concepts/why-super-harness' },
            { text: 'The live session tree', link: '/concepts/session-tree' },
            { text: 'Plugin architecture', link: '/concepts/plugin-architecture' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Packages',
          items: [
            { text: '@super-harness/core', link: '/reference/core' },
            { text: '@super-harness/shared', link: '/reference/shared' },
            { text: '@super-harness/server', link: '/reference/server' },
            { text: '@super-harness/react', link: '/reference/react' },
            { text: '@super-harness/tui', link: '/reference/tui' },
          ],
        },
      ],
    },
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/mertdogar/super-harness' }],
    editLink: {
      pattern: 'https://github.com/mertdogar/super-harness/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 Mert Dogar',
    },
  },
})
