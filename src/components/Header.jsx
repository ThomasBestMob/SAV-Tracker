/**
 * Barre unique et compacte. La version précédente occupait ~220px de haut avec
 * un titre géant et un sous-titre explicatif : sur un poste de travail SAV, cette
 * hauteur est prise sur la file de tickets, qui est le seul contenu utile.
 * Marque réduite à un repère, navigation et filtres sur la même ligne.
 */
export default function Header({ views, currentView, setCurrentView, channels, selectedChannel, setSelectedChannel, period, setPeriod }) {
  const selectCls =
    'bg-transparent border border-ink/20 px-2 py-1 text-[11px] font-mono uppercase tracking-wider focus:outline-none focus:border-accent';

  return (
    <header className="border-b border-ink/10 bg-paper sticky top-0 z-30">
      <div className="max-w-[1600px] mx-auto px-6 h-14 flex items-center gap-6">
        <div className="font-display text-lg font-medium tracking-tight shrink-0">
          SAV<span className="text-accent">.</span>
        </div>

        <nav className="flex gap-0.5 flex-1 min-w-0">
          {views.map((v) => (
            <button
              key={v.id}
              onClick={() => setCurrentView(v.id)}
              className={`px-3 py-1.5 text-[11px] uppercase tracking-widest font-medium transition-colors border-b-2 whitespace-nowrap ${
                currentView === v.id ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'
              }`}
            >
              {v.label}
            </button>
          ))}
        </nav>

        <div className="flex gap-2 items-center shrink-0">
          <select className={selectCls} value={selectedChannel} onChange={(e) => setSelectedChannel(e.target.value)}>
            <option value="all">Tous canaux</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <select className={selectCls} value={period} onChange={(e) => setPeriod(e.target.value)}>
            <option value="7">7 j</option>
            <option value="30">30 j</option>
            <option value="90">90 j</option>
            <option value="365">1 an</option>
          </select>
        </div>
      </div>
    </header>
  );
}
