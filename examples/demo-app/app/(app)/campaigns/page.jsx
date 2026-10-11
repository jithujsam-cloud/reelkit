'use client';
import { useState } from 'react';

const INITIAL = [
  { name: 'Q3 Enterprise', channel: 'Email', status: 'Active', sent: 2840, replies: '11.2%' },
  { name: 'Founders follow-up', channel: 'LinkedIn', status: 'Active', sent: 960, replies: '18.4%' },
  { name: 'Product launch', channel: 'Email', status: 'Paused', sent: 5120, replies: '6.9%' },
  { name: 'Agency outreach', channel: 'Calls', status: 'Draft', sent: 0, replies: '—' },
];

export default function Campaigns() {
  const [rows, setRows] = useState(INITIAL);
  const [open, setOpen] = useState(false);
  const [fresh, setFresh] = useState(null);

  function create(e) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get('name') || '').trim() || 'Untitled campaign';
    const channel = form.get('channel');
    setRows((r) => [{ name, channel, status: 'Draft', sent: 0, replies: '—' }, ...r]);
    setFresh(name);
    setOpen(false);
  }

  return (
    <div>
      <header className="page-head">
        <div>
          <h1>Campaigns</h1>
          <p className="muted">{rows.length} campaigns · 2 running</p>
        </div>
        <button className="btn btn-primary" onClick={() => setOpen(true)}>New campaign</button>
      </header>
      <div className="card table-card">
        <table className="table">
          <thead>
            <tr><th>Name</th><th>Channel</th><th>Status</th><th className="num">Sent</th><th className="num">Reply rate</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className={r.name === fresh ? 'row-new' : ''}>
                <td><b>{r.name}</b></td>
                <td>{r.channel}</td>
                <td><span className={`status status-${r.status.toLowerCase()}`}>{r.status}</span></td>
                <td className="num">{r.sent.toLocaleString('en-US')}</td>
                <td className="num">{r.replies}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && (
        <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
          <form className="modal" role="dialog" aria-modal="true" aria-label="New campaign" onSubmit={create}>
            <h2>New campaign</h2>
            <p className="muted">Give it a name and pick a channel. You can add steps next.</p>
            <label htmlFor="campaign-name">Name</label>
            <input id="campaign-name" name="name" autoComplete="off" placeholder="e.g. Q4 Outbound" />
            <label htmlFor="channel">Channel</label>
            <select id="channel" name="channel" defaultValue="Email">
              <option>Email</option>
              <option>LinkedIn</option>
              <option>Calls</option>
            </select>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Create campaign</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
