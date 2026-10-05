import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'

// Design system: tokens first, then the base styles that use them.
import './styles/tokens.css'
import './styles/app.css'

createApp(App).use(createPinia()).use(router).mount('#app')
