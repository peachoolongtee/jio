import { createApp } from 'vue'
import { createPinia } from 'pinia'

import 'bootstrap/dist/css/bootstrap.min.css'
// Loaded after Bootstrap so the design tokens can override its variables.
import './styles/tokens.css'
import './styles/app.css'

import App from './App.vue'
import router from './router'

createApp(App).use(createPinia()).use(router).mount('#app')
