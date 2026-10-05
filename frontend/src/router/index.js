import { createRouter, createWebHistory } from 'vue-router'

// Routes from build spec v2 §9.6. `requiresAuth` is read by the auth guard,
// which arrives with the auth ticket.
const routes = [
  { path: '/', name: 'landing', component: () => import('../views/LandingView.vue') },
  { path: '/login', name: 'login', component: () => import('../views/AuthView.vue') },
  { path: '/signup', name: 'signup', component: () => import('../views/AuthView.vue') },
  // Public: holds the invite token through signup.
  { path: '/join/:token', name: 'join', component: () => import('../views/JoinView.vue') },
  { path: '/groups', name: 'groups', component: () => import('../views/GroupsView.vue'), meta: { requiresAuth: true } },
  { path: '/groups/:id', name: 'group', component: () => import('../views/GroupDetailView.vue'), meta: { requiresAuth: true } },
  { path: '/groups/:id/events/new', name: 'event-new', component: () => import('../views/CreateEventView.vue'), meta: { requiresAuth: true } },
  { path: '/groups/:id/ledger', name: 'ledger', component: () => import('../views/LedgerView.vue'), meta: { requiresAuth: true } },
  { path: '/events/:id/plan', name: 'planner', component: () => import('../views/PlannerView.vue'), meta: { requiresAuth: true } },
  { path: '/events/:id/roam', name: 'roam', component: () => import('../views/RoamView.vue'), meta: { requiresAuth: true } },
  { path: '/events/:id', name: 'event', component: () => import('../views/EventView.vue'), meta: { requiresAuth: true } },
  { path: '/profile', name: 'profile', component: () => import('../views/ProfileView.vue'), meta: { requiresAuth: true } },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export default createRouter({
  history: createWebHistory(),
  routes,
})
