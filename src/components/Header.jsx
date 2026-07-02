export default function Header({ views, currentView, setCurrentView, channels, selectedChannel, setSelectedChannel, period, setPeriod }) {
  return (
    <header className="border-b border-ink/10 bg-paper sticky top-0 z-30">
      <div className="max-w-[1400px] mx-auto px-8 py-3 flex justify-between items-center text-[10px] uppercase tracking-widest text-muted border-b border-ink/5">
        <span>BestMobilier · SAV · {new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
        <span className="font-mono">Données eDesk</span>
      </div>
      <div className="max-w-[1400px] mx-auto px-8 pt-8 pb-6">
        <h1 className="font-display text-5xl font-medium tracking-tight leading-none">
          SAV Tracker<span className="text-accent">.</span>
        </h1>
        <p className="text-sm text-muted mt-2 max-w-2xl">
          Priorisation, notation et analyse produit des tickets SAV — site &amp; marketplaces, centralisés via eDesk.
        </p>
      </div>
      <div className="max-w-[1400px] mx-auto px-8 flex items-end justify-between border-t border-ink/10 pt-3 pb-3 gap-6 flex-wrap">
        <nav className="flex gap-1">
          {views.map((v) => (
            <button
              key={v.id}
              onClick={() => setCurrentView(v.id)}
              className={`px-4 py-2 text-xs uppercase tracking-widest font-medium transition-colors border-b-2 ${
                currentView === v.id
                  ? 'border-accent text-ink'
                  : 'border-transparent text-muted hover:text-ink'
              }`}
            >
              {v.label}
            </button>
          ))}
        </nav>
        <div className="flex gap-3 items-center text-xs">
          <select
            className="bg-transparent border border-ink/20 px-3 py-1.5 font-mono uppercase tracking-wider focus:outline-none focus:border-accent"
            value={selectedChannel}
            onChange={(e) => setSelectedChannel(e.target.value)}
          >
            <option value="all">Tous les canaux</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <select
            className="bg-transparent border border-ink/20 px-3 py-1.5 font-mono uppercase tracking-wider focus:outline-none focus:border-accent"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
          >
            <option value="7">7 jours</option>
            <option value="30">30 jours</option>
            <option value="90">90 jours</option>
            <option value="365">1 an</option>
          </select>
        </div>
      </div>
    </header>
  );
}
