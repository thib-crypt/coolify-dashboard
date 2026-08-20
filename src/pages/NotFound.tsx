import { Link } from 'react-router'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import './pages.css'

/** Inside the shell, so a mistyped URL keeps the rail and the live channel. */
export function NotFound() {
  useDocumentTitle('Not found')

  return (
    <header className="page-top">
      <h1>No such page</h1>
      <p>
        That address is not one of the dashboard's. <Link to="/">Back to the overview</Link>.
      </p>
    </header>
  )
}
