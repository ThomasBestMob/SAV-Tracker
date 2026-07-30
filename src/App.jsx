import { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';
import Header from './components/Header';
import Queue from './views/Queue';
import Channels from './views/Channels';
import Products from './views/Products';
import { channelLabel } from './lib/triage';

const VIEWS = [
  { id: 'queue', label: 'Ma journée', component: Queue },
  { id: 'products', label: 'Anomalies produit', component: Products },
  { id: 'channels', label: 'Pilotage canal', component: Channels },
];

export default function App() {
  const [currentView, setCurrentView] = useState('queue');
  const [channels, setChannels] = useState([]);
  const [selectedChannel, setSelectedChannel] = useState('all');
  const [period, setPeriod] = useState('30');

  // Canaux canoniques (mêmes clés que marketplace-tracker), pas les 33 canaux
  // eDesk bruts : ceux-ci sont des comptes/boutiques (un par pays, par compte
  // marchand), illisibles pour le pilotage. On ne liste que ceux réellement
  // présents dans les données.
  useEffect(() => {
    supabase
      .from('sav_channel_stats')
      .select('channel_key,nb_tickets_30j')
      .then(({ data, error }) => {
        if (error || !data) return;
        setChannels(
          data
            .filter((c) => c.channel_key)
            .sort((a, b) => (b.nb_tickets_30j || 0) - (a.nb_tickets_30j || 0))
            .map((c) => ({ id: c.channel_key, name: channelLabel(c.channel_key) }))
        );
      });
  }, []);

  const ActiveView = VIEWS.find((v) => v.id === currentView)?.component || Queue;

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
      <main className="max-w-[1600px] mx-auto px-6 py-6">
        <ActiveView selectedChannel={selectedChannel} period={period} channels={channels} />
      </main>
      <footer className="max-w-[1600px] mx-auto px-6 py-6 text-[11px] text-muted border-t border-rule/10 mt-12 flex justify-between">
        <span>BestMobilier · SAV Tracker · v2.1</span>
        <span className="font-mono">Sync manuel — run automatique désactivé</span>
      </footer>
    </div>
  );
}
