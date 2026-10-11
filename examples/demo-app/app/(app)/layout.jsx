import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, isValidSession } from '../../lib/auth';
import Sidebar from '../../components/Sidebar';

export default async function AppLayout({ children }) {
  const store = await cookies();
  if (!isValidSession(store.get(SESSION_COOKIE)?.value)) {
    redirect('/login');
  }
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-main">{children}</main>
    </div>
  );
}
