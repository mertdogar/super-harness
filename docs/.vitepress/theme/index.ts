import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import HarnessHome from './components/HarnessHome.vue'
import './styles/brand.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('HarnessHome', HarnessHome)
  },
} satisfies Theme
