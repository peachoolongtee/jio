import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth.js'
import { installPageTransitions } from '@/lib/viewTransition.js'

// meta.tabs: show the tab bar (top-level screens only; flow screens have a back arrow instead).
// meta.tab: which tab of the bar is current on that screen (the id of the tab in TabBar.vue).
// meta.nav: false hides all navigation (sign-up and the full-screen map).
// meta.public: open without an account.
const routes = [
  { path: '/signup', name: 'signup', component: () => import('@/views/AuthView.vue'), meta: { nav: false, public: true, title: 'Sign up' } },
  { path: '/', name: 'home', component: () => import('@/views/LandingView.vue'), meta: { tabs: true, tab: 'home', title: 'Home' } },
  { path: '/sessions', name: 'sessions', component: () => import('@/views/GroupsView.vue'), meta: { tabs: true, tab: 'home', title: 'Sessions' } },
  { path: '/sessions/new', name: 'session-create', component: () => import('@/views/CreateEventView.vue'), meta: { title: 'Create session' } },
  { path: '/sessions/:id', name: 'session', component: () => import('@/views/GroupDetailView.vue'), props: true, meta: { title: 'Session' } },
  { path: '/sessions/:id/edit', name: 'session-edit', component: () => import('@/views/CreateEventView.vue'), props: true, meta: { title: 'Edit session' } },
  { path: '/sessions/:id/invite', name: 'session-invite', component: () => import('@/views/InviteView.vue'), props: true, meta: { title: 'Invite friends' } },
  { path: '/sessions/:id/plan', name: 'session-plan', component: () => import('@/views/PlannerView.vue'), props: true, meta: { title: 'Vote' } },
  { path: '/sessions/:id/itinerary', name: 'session-itinerary', component: () => import('@/views/EventView.vue'), props: true, meta: { title: 'Itinerary' } },
  { path: '/sessions/:id/photos', name: 'session-photos', component: () => import('@/views/PhotosView.vue'), props: true, meta: { title: 'Photos' } },
  { path: '/sessions/:id/map', name: 'session-map', component: () => import('@/views/SessionMapView.vue'), props: true, meta: { nav: false, title: 'Map' } },
  { path: '/leaderboard', name: 'leaderboard', component: () => import('@/views/LeaderboardView.vue'), meta: { tabs: true, tab: 'leaderboard', title: 'Leaderboard' } },
  { path: '/rewards', name: 'rewards', component: () => import('@/views/RewardsView.vue'), meta: { tabs: true, tab: 'rewards', title: 'Rewards' } },
  { path: '/profile', name: 'profile', component: () => import('@/views/ProfileView.vue'), meta: { tabs: true, tab: 'profile', title: 'Profile' } },
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
    // Between the steps of one session, with the steps bar still on screen: stay put, so the bar a person just
    // pressed does not jump to the top of the window. Otherwise (the bar scrolled away) a new screen starts at the top.
    if (!saved && !to.hash && to.params.id && to.params.id === from.params.id) {
      const bar = document.querySelector('.steps')?.getBoundingClientRect()
      if (bar && bar.bottom > 0 && bar.top < window.innerHeight) return false
    }
    if (saved) return saved
    // A link to a section, such as /sessions/s1#photos: give the screen a moment to draw it, then scroll there
    // (without gliding, for people who asked for less motion).
    if (to.hash) {
      const behavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
      return new Promise((resolve) => setTimeout(() => resolve({ el: to.hash, top: 16, behavior }), 300))
    }
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
