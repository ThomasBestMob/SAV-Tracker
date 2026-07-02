import { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';
import Header from './components/Header';
import Tickets from './views/Tickets';
import Notation from './views/Notation';
import Products from './views/Products';

const VIEWS = [
  { id: 'tickets', label: 'Tickets', component: Tickets },
  { id: 'notation', label: 'Notation', component: Notation },
  { id: 'products', label: 'Stats produit', component: Products },
];

export default function App() {
  const [currentView, setCurrentView] = useState('tickets');
  const [channels, setChannels] = useState([]);
  const [selectedChannel, setSelectedChannel] = useState('all');
  const [period, setPeriod] = useState('30');

  useEffect(() => {
    supabase
      .from('sav_channels')
      .select('id,name')
      .order('name')
      .then(({ data, error }) => {
        if (!error && data) setChannels(data);
      });
  }, []);

  const ActiveView = VIEWS.find((v) => v.id === currentView)?.component || Tickets;

  return (
    <div className="min-h-screen bg-paper">
      <Header
        views={VIEWS}
        currentView={currentView}
        setCurrentView={setCurrentView}
        channels={channels}
        selectedChannel={selectedChannel}
        setSelectedChannel={setSelectedChannel}
        period={period}
        setPeriod={setPeriod}
      />
      <main className="max-w-[1400px] mx-auto px-8 py-10">
        <ActiveView selectedChannel={selectedChannel} period={period} channels={channels} />
      </main>
      <footer className="max-w-[1400px] mx-auto px-8 py-12 text-xs text-muted border-t border-rule/10 mt-20 flex justify-between">
        <span>BestMobilier · SAV Tracker · v0.1 (eDesk)</span>
        <span className="font-mono">Sync toutes les heures</span>
      </footer>
    </div>
  );
}
