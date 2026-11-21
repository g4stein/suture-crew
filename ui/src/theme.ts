/** Suture's obsidian-slate tokens (WCAG-AA on the obsidian/panel surfaces), scoped to the `.sc` page root. */
export const TOKENS = {
  obsidian: '#090B10',
  panel: '#10141D',
  raised: '#171C28',
  cyan: '#06B6D4',
  emerald: '#10B981',
  amber: '#F59E0B',
  crimson: '#F43F5E',
  text: '#E2E8F0',
  muted: '#94A3B8',
} as const;

export const CSS = `
.sc { --sc-obsidian:${TOKENS.obsidian}; --sc-panel:${TOKENS.panel}; --sc-raised:${TOKENS.raised}; --sc-cyan:${TOKENS.cyan};
  --sc-emerald:${TOKENS.emerald}; --sc-amber:${TOKENS.amber}; --sc-crimson:${TOKENS.crimson}; --sc-text:${TOKENS.text}; --sc-muted:${TOKENS.muted};
  background:var(--sc-obsidian); color:var(--sc-text); min-height:100%; flex:1; overflow-y:auto; padding:20px 24px 32px;
  font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace; box-sizing:border-box; }
.sc *, .sc *::before, .sc *::after { box-sizing:inherit; }
.sc h1 { font-size:18px; margin:0; letter-spacing:.02em; }
.sc h2 { font-size:12px; margin:0 0 10px; text-transform:uppercase; letter-spacing:.08em; color:var(--sc-muted); font-weight:600; }
.sc-head { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:16px; }
.sc-head p { margin:0; color:var(--sc-muted); flex-basis:100%; }
.sc-grid { display:grid; gap:14px; grid-template-columns:minmax(260px,1fr) minmax(320px,1.4fr); }
@media (max-width:900px) { .sc-grid { grid-template-columns:1fr; } }
.sc-card { background:var(--sc-panel); border:1px solid var(--sc-raised); border-radius:10px; padding:14px; min-width:0; }
.sc-stack { display:flex; flex-direction:column; gap:14px; min-width:0; }
.sc-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.sc-btn { background:var(--sc-raised); color:var(--sc-text); border:1px solid #232a3a; border-radius:6px; padding:6px 10px; font:inherit; cursor:pointer; }
.sc-btn:hover { border-color:var(--sc-cyan); }
.sc-btn:focus-visible, .sc a:focus-visible, .sc-item:focus-visible { outline:2px solid var(--sc-cyan); outline-offset:2px; }
.sc-btn[disabled] { opacity:.5; cursor:not-allowed; }
.sc-btn.primary { background:var(--sc-cyan); color:var(--sc-obsidian); border-color:var(--sc-cyan); font-weight:700; }
.sc-badge { display:inline-block; border-radius:999px; padding:1px 8px; font-size:11px; font-weight:700; border:1px solid currentColor; white-space:nowrap; }
.sc-badge.violated, .sc-badge.rejected { color:var(--sc-crimson); }
.sc-badge.passed, .sc-badge.verified { color:var(--sc-emerald); }
.sc-badge.configError, .sc-badge.stopped, .sc-badge.paused { color:var(--sc-amber); }
.sc-badge.unaudited, .sc-badge.info { color:var(--sc-muted); }
.sc-badge.active { color:var(--sc-cyan); }
.sc-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:6px; }
.sc-item { width:100%; text-align:left; display:flex; justify-content:space-between; gap:8px; align-items:center; background:transparent;
  border:1px solid var(--sc-raised); border-radius:8px; padding:8px 10px; color:inherit; font:inherit; cursor:pointer; }
.sc-item[aria-pressed="true"] { border-color:var(--sc-cyan); background:#0c1a22; }
.sc-item small { color:var(--sc-muted); display:block; }
.sc-muted { color:var(--sc-muted); }
.sc-chain { display:flex; flex-wrap:wrap; gap:4px; align-items:center; margin:8px 0; }
.sc-step { border:1px solid var(--sc-raised); border-radius:6px; padding:4px 6px; background:var(--sc-obsidian); }
.sc-step.bad { border-color:var(--sc-crimson); }
.sc-dialect { font-size:10px; font-weight:700; margin-right:4px; }
.sc-dialect.sql { color:var(--sc-cyan); } .sc-dialect.py { color:var(--sc-amber); } .sc-dialect.formula { color:var(--sc-emerald); } .sc-dialect.literal { color:var(--sc-muted); }
.sc-arrow { color:var(--sc-muted); }
.sc table { width:100%; border-collapse:collapse; font-size:12px; }
.sc th, .sc td { text-align:left; padding:4px 6px; border-bottom:1px solid var(--sc-raised); vertical-align:top; }
.sc th { color:var(--sc-muted); font-weight:600; }
.sc code, .sc pre { background:var(--sc-obsidian); border:1px solid var(--sc-raised); border-radius:4px; }
.sc code { padding:0 4px; }
.sc pre { padding:8px; margin:4px 0; white-space:pre-wrap; word-break:break-all; }
.sc pre.before { border-left:3px solid var(--sc-crimson); } .sc pre.after { border-left:3px solid var(--sc-emerald); }
.sc a.sc-link { color:var(--sc-cyan); font-weight:700; }
.sc-check { display:flex; gap:6px; align-items:baseline; }
.sc-check .ok { color:var(--sc-emerald); } .sc-check .no { color:var(--sc-crimson); } .sc-check .na { color:var(--sc-muted); }
.sc textarea { width:100%; min-height:90px; background:var(--sc-obsidian); color:var(--sc-text); border:1px solid var(--sc-raised); border-radius:6px; font:inherit; padding:8px; }
.sc-error { color:var(--sc-crimson); }
`;
