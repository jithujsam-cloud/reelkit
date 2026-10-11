'use client';
import { useEffect, useState } from 'react';
import { BarChart, Donut, LineChart } from '../../../components/Charts';

// ?chaos=1       -> skeleton lingers ~3.5s and cards use a slow 2.5s entrance animation
// ?chaos=forever -> skeleton never resolves (the stability engine must refuse to capture)
function chaosMode() {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('chaos');
}

function Skeleton() {
  return (
    <div className="dash-grid" aria-busy="true">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="card kpi skeleton-card"><div className="skeleton sk-line short" /><div className="skeleton sk-line tall" /></div>
      ))}
      <div className="card span-3 skeleton-card"><div className="skeleton sk-block" /></div>
      <div className="card span-1 skeleton-card"><div className="skeleton sk-block" /></div>
    </div>
  );
}

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [chaos, setChaos] = useState(null);
  const [toast, setToast] = useState(false);

  useEffect(() => {
    const mode = chaosMode();
    setChaos(mode);
    if (mode === 'forever') return;
    const delay = mode === '1' ? 3500 : 900;
    fetch(`/api/stats?delay=${delay}`)
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setToast(true);
        setTimeout(() => setToast(false), 4000);
      });
  }, []);

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  return (
    <div className={chaos === '1' ? 'dashboard chaos-slow' : 'dashboard'}>
      <header className="page-head">
        <div>
          <h1>Good morning, Jordan</h1>
          <p className="muted">{today} · Here is how your outbound is performing.</p>
        </div>
        <a className="btn btn-primary" href="/campaigns">New campaign</a>
      </header>
      {!data ? (
        <Skeleton />
      ) : (
        <div className="dash-grid">
          {data.kpis.map((k, i) => (
            <div key={k.label} className="card kpi enter" style={{ animationDelay: `${i * 60}ms` }}>
              <span className="kpi-label">{k.label}</span>
              <strong className="kpi-value">{k.value}</strong>
              <span className={k.up ? 'delta up' : 'delta down'}>{k.delta} vs last month</span>
            </div>
          ))}
          <div className="card span-3 enter" style={{ animationDelay: '240ms' }}>
            <div className="card-head"><h2>Revenue</h2><span className="muted">Last 12 weeks</span></div>
            <LineChart data={data.weekly} />
          </div>
          <div className="card span-1 enter" style={{ animationDelay: '300ms' }}>
            <div className="card-head"><h2>Channel mix</h2></div>
            <Donut data={data.channels} />
          </div>
          <div className="card span-2 enter" style={{ animationDelay: '360ms' }}>
            <div className="card-head"><h2>Weekly replies</h2></div>
            <BarChart data={data.weekly} />
          </div>
          <div className="card span-2 enter" style={{ animationDelay: '420ms' }}>
            <div className="card-head"><h2>Recent activity</h2></div>
            <ul className="activity">
              {data.activity.map((a) => (
                <li key={a.who}>
                  <div className="avatar small">{a.who.split(' ').map((p) => p[0]).join('')}</div>
                  <p><b>{a.who}</b> {a.what} <b>{a.target}</b></p>
                  <time>{a.when} ago</time>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {toast && <div className="toast" role="status">Welcome back! Your weekly report is ready.</div>}
    </div>
  );
}
