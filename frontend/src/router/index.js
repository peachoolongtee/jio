import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth.js'
import { installPageTransitions } from '@/lib/viewTransition.js'

// meta.tabs: show the mobile tab bar (top-level screens only; flow screens have a back arrow instead).
// meta.nav: false hides all navigation (sign-up and the full-screen map).
// meta.public: open without an account.
const routes = [
  { path: '/signup', name: 'signup', component: () => import('@/views/AuthView.vue'), meta: { nav: false, public: true, title: 'Sign up' } },
  { path: '/', name: 'home', component: () => import('@/views/LandingView.vue'), meta: { tabs: true, title: 'Home' } },
  { path: '/sessions', name: 'sessions', component: () => import('@/views/GroupsView.vue'), meta: { tabs: true, title: 'Sessions' } },
  { path: '/sessions/new', name: 'session-create', component: () => import('@/views/CreateEventView.vue'), meta: { title: 'Create session' } },
  { path: '/sessions/:id', name: 'session', component: () => import('@/views/GroupDetailView.vue'), props: true, meta: { title: 'Session' } },
  { path: '/sessions/:id/invite', name: 'session-invite', component: () => import('@/views/InviteView.vue'), props: true, meta: { title: 'Invite friends' } },
  { path: '/sessions/:id/plan', name: 'session-plan', component: () => import('@/views/PlannerView.vue'), props: true, meta: { title: 'Vote' } },
  { path: '/sessions/:id/itinerary', name: 'session-itinerary', component: () => import('@/views/EventView.vue'), props: true, meta: { title: 'Itinerary' } },
  { path: '/sessions/:id/photos', name: 'session-photos', component: () => import('@/views/PhotosView.vue'), props: true, meta: { title: 'Photos' } },
  { path: '/sessions/:id/map', name: 'session-map', component: () => import('@/views/SessionMapView.vue'), props: true, meta: { nav: false, title: 'Map' } },
  { path: '/leaderboard', name: 'leaderboard', component: () => import('@/views/LeaderboardView.vue'), meta: { tabs: true, title: 'Leaderboard' } },
  { path: '/rewards', name: 'rewards', component: () => import('@/views/RewardsView.vue'), meta: { tabs: true, title: 'Rewards' } },
  { path: '/profile', name: 'profile', component: () => import('@/views/ProfileView.vue'), meta: { tabs: true, title: 'Profile' } },
  { path: '/people/:id', name: 'person', component: () => import('@/views/ProfileView.vue'), props: true, meta: { title: 'Profile' } },
  { path: '/design-system', name: 'design-system', component: () => import('@/views/DesignSystemView.vue'), meta: { public: true, title: 'Design system' } },
  { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('@/views/NotFoundView.vue'), meta: { public: true, title: 'Not found' } },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior: (to, from, saved) => {
    // Only the query changed on the same screen, such as a place opening over Home (?place=…): stay put.
    if (to.path === from.path && to.hash === from.hash) return false
    if (saved) return saved
    // A link to a section, such as /sessions/s1#photos: give the screen a moment to draw it, then scroll there.
    if (to.hash) return new Promise((resolve) => setTimeout(() => resolve({ el: to.hash, top: 16, behavior: 'smooth' }), 300))
    return { top: 0 }
  },
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  await auth.init()
  if (!to.meta.public && !auth.signedIn) return { name: 'signup' }
  if (to.name === 'signup' && auth.signedIn) return { name: 'home' }
  return true
})

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} · Jio` : 'Jio'
})

// Moving between screens cross-fades instead of jumping (lib/viewTransition.js).
installPageTransitions(router)

export default router
