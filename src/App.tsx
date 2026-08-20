import { BrowserRouter, Route, Routes } from 'react-router'
import { Login } from './components/Login'
import { Shell } from './layout/Shell'
import { ApplicationDetail } from './pages/ApplicationDetail'
import { Applications } from './pages/Applications'
import { Deployments } from './pages/Deployments'
import { NotFound } from './pages/NotFound'
import { Overview } from './pages/Overview'
import { Schedule } from './pages/Schedule'
import { Servers } from './pages/Servers'
import { SetupPage } from './pages/SetupPage'
import { useSession } from './hooks/useSession'

/**
 * The session gate, then the routes.
 *
 * `Shell` is a layout route: the payload, the SSE channel and the actions are
 * mounted once inside it and handed down through the outlet context, so moving
 * between pages neither refetches nor drops the live stream. It also means the
 * dashboard is mounted only once the door is open — otherwise it would open a
 * stream and a refetch loop that could only ever collect 401s.
 *
 * Deep links survive a reload because the BFF serves the SPA shell for any path
 * it does not claim itself (`server/static.ts`).
 */
export default function App() {
  const { state, required, signIn, signOut } = useSession()

  // One request long, and only on a cold load. A sign-in form that appears and
  // then vanishes is worse than a frame of nothing.
  if (state === 'unknown') return null
  if (state === 'locked') return <Login onSubmit={signIn} />

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Shell {...(required ? { onSignOut: signOut } : {})} />}>
          <Route index element={<Overview />} />
          <Route path="applications" element={<Applications />} />
          <Route path="applications/:uuid" element={<ApplicationDetail />} />
          <Route path="deployments" element={<Deployments />} />
          <Route path="servers" element={<Servers />} />
          <Route path="schedule" element={<Schedule />} />
          <Route path="setup" element={<SetupPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
