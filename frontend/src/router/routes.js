// meta.tabs: show the tab bar (top-level screens only; flow screens have a back arrow instead).
// meta.tab: which tab of the bar is current on that screen (the id of the tab in TabBar.vue).
// meta.nav: false hides all navigation (sign-up and the full-screen map).
// meta.public: open without an account.
// The router's rules about who may open what are in router/guard.js.
export const routes = [
  { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue'), meta: { nav: false, public: true, title: 'Log in' } },
  { path: '/signup', name: 'signup', component: () => import('@/views/AuthView.vue'), meta: { nav: false, public: true, title: 'Sign up' } },
  { path: '/forgot-password', name: 'forgot-password', component: () => import('@/views/ForgotPasswordView.vue'), meta: { nav: false, public: true, title: 'Forgot password' } },
  { path: '/reset-password', name: 'reset-password', component: () => import('@/views/ResetPasswordView.vue'), meta: { nav: false, public: true, title: 'New password' } },
  // An invite link. Public: anyone sees what they are invited to; joining needs an account (views/JoinView.vue).
  { path: '/join/:token', name: 'join', component: () => import('@/views/JoinView.vue'), props: true, meta: { nav: false, public: true, title: 'Join session' } },
  { path: '/', name: 'home', component: () => import('@/views/LandingView.vue'), meta: { tabs: true, tab: 'home', title: 'Home' } },
  { path: '/sessions', name: 'sessions', component: () => import('@/views/GroupsView.vue'), meta: { tabs: true, tab: 'home', title: 'Sessions' } },
  { path: '/sessions/new', name: 'session-create', component: () => import('@/views/CreateEventView.vue'), meta: { title: 'Create session' } },
  { path: '/sessions/:id', name: 'session', component: () => import('@/views/GroupDetailView.vue'), props: true, meta: { title: 'Session' } },
  { path: '/sessions/:id/start', name: 'session-start', component: () => import('@/views/StartView.vue'), props: true, meta: { title: 'How to meet' } },
  { path: '/sessions/:id/edit', name: 'session-edit', component: () => import('@/views/CreateEventView.vue'), props: true, meta: { title: 'Edit session' } },
  { path: '/sessions/:id/invite', name: 'session-invite', component: () => import('@/views/InviteView.vue'), props: true, meta: { title: 'Invite friends' } },
  { path: '/sessions/:id/plan', name: 'session-plan', component: () => import('@/views/PlannerView.vue'), props: true, meta: { title: 'Vote' } },
  { path: '/sessions/:id/itinerary', name: 'session-itinerary', component: () => import('@/views/EventView.vue'), props: true, meta: { title: 'Itinerary' } },
  { path: '/sessions/:id/photos', name: 'session-photos', component: () => import('@/views/PhotosView.vue'), props: true, meta: { title: 'Photos' } },
  { path: '/sessions/:id/map', name: 'session-map', component: () => import('@/views/SessionMapView.vue'), props: true, meta: { nav: false, title: 'Map' } },
  { path: '/sessions/:id/roam', name: 'session-roam', component: () => import('@/views/RoamView.vue'), props: true, meta: { title: 'What next?' } },
  { path: '/leaderboard', name: 'leaderboard', component: () => import('@/views/LeaderboardView.vue'), meta: { tabs: true, tab: 'leaderboard', title: 'Leaderboard' } },
  { path: '/rewards', name: 'rewards', component: () => import('@/views/RewardsView.vue'), meta: { tabs: true, tab: 'rewards', title: 'Rewards' } },
  { path: '/profile', name: 'profile', component: () => import('@/views/ProfileView.vue'), meta: { tabs: true, tab: 'profile', title: 'Profile' } },
  { path: '/profile/edit', name: 'profile-edit', component: () => import('@/views/EditProfileView.vue'), meta: { tab: 'profile', title: 'Edit profile' } },
  { path: '/profile/edit/password', name: 'profile-password', component: () => import('@/views/EditProfileView.vue'), meta: { tab: 'profile', title: 'Password' } },
  { path: '/people/:id', name: 'person', component: () => import('@/views/ProfileView.vue'), props: true, meta: { title: 'Profile' } },
  // /demo exists only in a build that has the demo tour: development, or VITE_DEMO_TOUR=1 (lib/tourFlag.js; written out here so the bundler drops it).
  ...(import.meta.env.DEV || import.meta.env.VITE_DEMO_TOUR === '1' ? [{ path: '/demo', name: 'demo', component: () => import('@/tour/DemoView.vue'), meta: { nav: false, public: true, title: 'Demo tour' } }] : []),
  { path: '/design-system', name: 'design-system', component: () => import('@/views/DesignSystemView.vue'), meta: { public: true, title: 'Design system' } },
  { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('@/views/NotFoundView.vue'), meta: { public: true, title: 'Not found' } },
]
