import { useNavigate } from 'react-router'
import { Setup } from '../components/Setup'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useShell } from '../layout/context'

/**
 * The setup check as a page of its own, reachable from the rail at any time —
 * not only after something has failed. Every probe behind it is a read.
 */
export function SetupPage() {
  useDocumentTitle('Setup check')

  const navigate = useNavigate()
  const { reload } = useShell()
  return <Setup onClose={() => void navigate('/')} onRetry={reload} />
}
